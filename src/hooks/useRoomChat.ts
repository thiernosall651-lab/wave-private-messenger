import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { mediaMimeType, uploadChatMedia, type MediaKind } from "@/lib/chat-media";

export const MAX_MESSAGE_LENGTH = 500;
const PAGE_SIZE = 200;

export type ChatMessage = {
  id: string;
  room_id: string;
  user_id: string;
  message: string;
  created_at: string;
  kind: "text" | MediaKind;
  media_path: string | null;
  media_mime: string | null;
  delivered_at: string | null;
  read_at: string | null;
  reply_to_message_id?: string | null;
  view_once: boolean;
  viewed_at: string | null;
  viewed_by: string | null;
  reactions: Record<string, string[]>;
  deleted_at: string | null;
  deleted_by: string | null;
};

const LEGACY_FIELDS = "id, room_id, user_id, message, created_at, kind, media_path, media_mime, delivered_at, read_at, reply_to_message_id";
const FIELDS = LEGACY_FIELDS + ", view_once, viewed_at, viewed_by, reactions";
const FULL_FIELDS = FIELDS + ", deleted_at, deleted_by";
const ALLOWED_REACTIONS = ["❤️", "😂", "😮", "😢", "👍", "🙏", "🔥", "💯"] as const;
type DeletePayload = { already_deleted?: boolean; media_path?: string | null; view_once_media_path?: string | null };
type Row = Partial<ChatMessage> & Record<string, unknown>;
type QueryResult = { data: unknown; error: { message: string } | null };
type ViewOncePayload = { already_opened?: boolean; kind: MediaKind | "text"; content: string | null; media_path: string | null; media_mime: string | null };

function normalizeMessage(message: Partial<ChatMessage> & Record<string, unknown>): ChatMessage {
  return {
    ...(message as ChatMessage),
    view_once: message.view_once === true,
    viewed_at: typeof message.viewed_at === "string" ? message.viewed_at : null,
    viewed_by: typeof message.viewed_by === "string" ? message.viewed_by : null,
    reactions: message.reactions && typeof message.reactions === "object" && !Array.isArray(message.reactions)
      ? message.reactions as Record<string, string[]>
      : {},
    deleted_at: typeof message.deleted_at === "string" ? message.deleted_at : null,
    deleted_by: typeof message.deleted_by === "string" ? message.deleted_by : null,
  };
}

function isFeatureSchemaError(message: string) {
  return /view_once|viewed_at|viewed_by|reactions/i.test(message) && /column|schema cache|does not exist|could not find|missing/i.test(message);
}

function isMissingColumn(message: string, columns: RegExp) {
  return columns.test(message) && /column|schema cache|does not exist|could not find|missing/i.test(message);
}

/** Next (older) column set to try when the database has not received a migration yet. */
function downgradeFields(current: string, message: string): string | null {
  if (current === FULL_FIELDS && isMissingColumn(message, /deleted_at|deleted_by/i)) return FIELDS;
  if (current !== LEGACY_FIELDS && isFeatureSchemaError(message)) return LEGACY_FIELDS;
  return null;
}

const ts = (m: ChatMessage) => new Date(m.created_at).getTime();
const byTime = (a: ChatMessage, b: ChatMessage) => ts(a) - ts(b) || a.id.localeCompare(b.id);

/**
 * Chat history for one room. The database is the source of truth:
 * history is fetched newest-first (so the latest message is always included),
 * realtime events and resyncs are only ever MERGED by id — the list is never
 * replaced or shrunk by a reconnect, refetch or partial payload.
 */
export function useRoomChat(roomId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [featuresAvailable, setFeaturesAvailable] = useState(false);
  const [featureSchemaMissing, setFeatureSchemaMissing] = useState(false);
  const [deleteAvailable, setDeleteAvailable] = useState(false);
  const fieldsRef = useRef(FULL_FIELDS);
  const reactionLocks = useRef(new Set<string>());
  const [typingUser, setTypingUser] = useState<string | null>(null);
  const [refs, setRefs] = useState<Record<string, ChatMessage | null>>({});
  const refsAsked = useRef(new Set<string>());
  const channelRef = useRef<RealtimeChannel | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSent = useRef(0);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  const merge = useCallback((incoming: ChatMessage[]) => {
    if (!incoming.length) return;
    setMessages((prev) => {
      const map = new Map(prev.map((m) => [m.id, m]));
      for (const raw of incoming) {
        if (!raw?.id) continue;
        const m = normalizeMessage(raw as unknown as Partial<ChatMessage> & Record<string, unknown>);
        const old = map.get(m.id);
        const next = old ? { ...old, ...m } : m;
        // Deleting is irreversible: a stale poll or late event must never bring the content back.
        if (old?.deleted_at) {
          next.deleted_at = old.deleted_at;
          next.deleted_by = old.deleted_by;
          next.message = "";
          next.media_path = null;
          next.media_mime = null;
          next.reactions = {};
        }
        map.set(m.id, next);
      }
      return [...map.values()].sort(byTime);
    });
  }, []);

  /** Record which optional columns the database really has, and derive the feature flags from it. */
  const adoptFields = useCallback((fields: string) => {
    fieldsRef.current = fields;
    setFeaturesAvailable(fields !== LEGACY_FIELDS);
    setFeatureSchemaMissing(fields === LEGACY_FIELDS);
    setDeleteAvailable(fields === FULL_FIELDS);
  }, []);

  /** Run a messages query; if a column is missing (migration not applied yet), retry with fewer columns. */
  const runSelect = useCallback(
    async (run: (fields: string) => PromiseLike<QueryResult>) => {
      let result = await run(fieldsRef.current);
      for (let attempt = 0; attempt < 2 && result.error; attempt++) {
        const next = downgradeFields(fieldsRef.current, result.error.message);
        if (!next) break;
        adoptFields(next);
        result = await run(next);
      }
      return result;
    },
    [adoptFields],
  );

  /** Fetch the latest page from the database and merge it in (never replaces). */
  const syncLatest = useCallback(async () => {
    const result = await runSelect((fields) => supabase.from("room_messages").select(fields).eq("room_id", roomId)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(PAGE_SIZE));
    if (result.error) return { ok: false, count: 0 };
    adoptFields(fieldsRef.current);
    const rows = (result.data ?? []) as unknown as Row[];
    merge(rows.map(normalizeMessage));
    return { ok: true, count: rows.length };
  }, [roomId, merge, runSelect, adoptFields]);

  const loadOlder = useCallback(async () => {
    const oldest = messagesRef.current[0];
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    const result = await runSelect((fields) => supabase.from("room_messages").select(fields).eq("room_id", roomId)
      .lt("created_at", oldest.created_at).order("created_at", { ascending: false }).limit(PAGE_SIZE));
    setLoadingOlder(false);
    if (result.error) {
      setLoadError("Could not load earlier messages.");
      return;
    }
    const rows = (result.data ?? []) as unknown as Row[];
    merge(rows.map(normalizeMessage));
    setHasMore(rows.length === PAGE_SIZE);
  }, [roomId, merge, loadingOlder, runSelect]);

  useEffect(() => {
    let active = true;
    let subscribedOnce = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    setMessages([]);
    setLoading(true);
    setLoadError(null);
    setHasMore(false);

    const initial = async (attempt = 0) => {
      const r = await syncLatest();
      if (!active) return;
      if (r.ok) {
        setLoadError(null);
        setHasMore(r.count === PAGE_SIZE);
        setLoading(false);
      } else if (attempt < 5) {
        retry = setTimeout(() => void initial(attempt + 1), 1500 * (attempt + 1));
      } else {
        setLoadError("Could not load messages. Check your connection.");
        setLoading(false);
      }
    };
    void initial();

    const channel = supabase
      .channel(`wave-chat:${roomId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "room_messages", filter: `room_id=eq.${roomId}` },
        (payload) => {
          if (!active) return;
          const m = payload.new as ChatMessage;
          merge([m]);
          setTypingUser((t) => (t === m.user_id ? null : t));
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "room_messages", filter: `room_id=eq.${roomId}` },
        (payload) => {
          if (active) merge([payload.new as ChatMessage]);
        },
      )
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        if (!active) return;
        const p = payload as { user_id?: string; stop?: boolean };
        if (typingTimer.current) clearTimeout(typingTimer.current);
        if (p.stop) {
          setTypingUser(null);
          return;
        }
        setTypingUser(p.user_id ?? null);
        typingTimer.current = setTimeout(() => setTypingUser(null), 3000);
      })
      .subscribe((status) => {
        if (!active) return;
        // On every (re)subscribe after the first, fetch anything missed while disconnected.
        if (status === "SUBSCRIBED") {
          if (subscribedOnce) void syncLatest();
          subscribedOnce = true;
        }
      });
    channelRef.current = channel;

    // Catch up after the tab was hidden / the phone was asleep / the network came back.
    const resync = () => {
      if (active && document.visibilityState === "visible") void syncLatest();
    };
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("online", resync);
    window.addEventListener("focus", resync);

    // Safety net for browsers where realtime events get dropped or suspended
    // while the tab or phone was idle. Realtime remains the primary path.
    const recoveryPoll = window.setInterval(() => {
      if (active && document.visibilityState === "visible") void syncLatest();
    }, 5000);

    return () => {
      active = false;
      channelRef.current = null;
      if (retry) clearTimeout(retry);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      window.clearInterval(recoveryPoll);
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("online", resync);
      window.removeEventListener("focus", resync);
      void supabase.removeChannel(channel);
    };
  }, [roomId, merge, syncLatest]);

  // Fetch quoted originals that are not in the loaded page (RLS keeps this to the current room).
  useEffect(() => {
    const loaded = new Set(messages.map((m) => m.id));
    const missing = [
      ...new Set(messages.map((m) => m.reply_to_message_id).filter((id): id is string => !!id && !loaded.has(id))),
    ].filter((id) => !refsAsked.current.has(id));
    if (!missing.length) return;
    missing.forEach((id) => refsAsked.current.add(id));
    void supabase
      .from("room_messages")
      .select(fieldsRef.current)
      .eq("room_id", roomId)
      .in("id", missing)
      .then(({ data, error }) => {
        if (error) {
          missing.forEach((id) => refsAsked.current.delete(id));
          return;
        }
        const found = new Map(((data ?? []) as unknown as ChatMessage[]).map((m) => [m.id, m]));
        setRefs((r) => ({ ...r, ...Object.fromEntries(missing.map((id) => [id, found.get(id) ?? null])) }));
      });
  }, [messages, roomId]);

  useEffect(() => {
    setRefs({});
    refsAsked.current = new Set();
  }, [roomId]);

  /** Load everything from the given message up to the current oldest so it can be scrolled to. */
  const ensureLoaded = useCallback(
    async (id: string) => {
      if (messagesRef.current.some((m) => m.id === id)) return true;
      const oldest = messagesRef.current[0];
      const targetResult = await runSelect((fields) => supabase.from("room_messages").select(fields).eq("room_id", roomId).eq("id", id).maybeSingle());
      const target = targetResult.data as unknown as Row | null;
      if (!target || !oldest) return false;
      const t = normalizeMessage(target);
      const rangeResult = await runSelect((fields) => supabase.from("room_messages").select(fields).eq("room_id", roomId)
        .gte("created_at", t.created_at).lte("created_at", oldest.created_at).order("created_at", { ascending: true }).limit(2000));
      if (rangeResult.error) return false;
      merge([t, ...((rangeResult.data ?? []) as unknown as Row[]).map(normalizeMessage)]);
      return true;
    },
    [roomId, merge, runSelect],
  );

  const notifyTyping = useCallback((userId: string, stop = false) => {
    const now = Date.now();
    if (!channelRef.current) return;
    if (!stop && now - lastSent.current < 1500) return;
    lastSent.current = stop ? 0 : now;
    void channelRef.current.send({ type: "broadcast", event: "typing", payload: { user_id: userId, stop } });
  }, []);

  /** Saves to the database first; the message only counts as sent once the row is returned. */
  const insert = useCallback(
    async (row: Record<string, unknown>) => {
      const { data, error } = await supabase.from("room_messages").insert(row as never).select(fieldsRef.current).single();
      if (error?.message?.includes("REPLY_INVALID")) throw new Error("The original message is no longer available.");
      if (error) throw new Error("Message could not be saved: " + error.message);
      if (!data) throw new Error("Message could not be confirmed by the database. Refresh the conversation before retrying.");
      merge([normalizeMessage(data as unknown as Partial<ChatMessage> & Record<string, unknown>)]);
    },
    [merge],
  );

  const send = useCallback(
    async (userId: string, text: string, replyTo: string | null = null, viewOnce = false) => {
      const message = text.trim();
      if (!message || message.length > MAX_MESSAGE_LENGTH) return false;
      setSending(true);
      setSendError(null);
      try {
        if (viewOnce) {
          const { data: id, error } = await supabase.rpc("send_view_once_message", {
            p_room_id: roomId, p_kind: "text", p_content: message, p_media_path: null, p_media_mime: null, p_reply_to_message_id: replyTo,
          });
          if (error || !id) throw new Error(error?.message ?? "Could not send view-once message.");
          const { data, error: fetchError } = await supabase.from("room_messages").select(fieldsRef.current).eq("id", id).single();
          if (fetchError || !data) throw new Error("Message was sent, but the conversation needs to refresh.");
          merge([normalizeMessage(data as unknown as Partial<ChatMessage> & Record<string, unknown>)]);
        } else {
          await insert({ room_id: roomId, user_id: userId, message, ...(replyTo ? { reply_to_message_id: replyTo } : {}) });
        }
        notifyTyping(userId, true);
        return true;
      } catch (e) {
        setSendError((e as Error).message);
        return false;
      } finally {
        setSending(false);
      }
    },
    [roomId, insert, notifyTyping, merge],
  );

  const sendMedia = useCallback(
    async (userId: string, kind: MediaKind, file: Blob, caption = "", replyTo: string | null = null, viewOnce = false, onProgress?: (percent: number) => void) => {
      setSending(true);
      setUploadProgress(0);
      setSendError(null);
      let uploadedPath: string | null = null;
      let messageSaved = false;
      const bucket = viewOnce ? "chat-view-once" : "chat-media";
      try {
        uploadedPath = await uploadChatMedia(roomId, userId, kind, file, onProgress ?? setUploadProgress, viewOnce);
        if (viewOnce) {
          const { data: id, error } = await supabase.rpc("send_view_once_message", {
            p_room_id: roomId, p_kind: kind, p_content: caption.trim().slice(0, MAX_MESSAGE_LENGTH), p_media_path: uploadedPath,
            p_media_mime: mediaMimeType(file, kind) || null, p_reply_to_message_id: replyTo,
          });
          if (error) throw new Error("Media uploaded, but the view-once message could not be saved: " + error.message);
          if (!id) throw new Error("Media uploaded, but no message ID was returned. Refresh the conversation.");
          messageSaved = true;
          const { data, error: fetchError } = await supabase.from("room_messages").select(fieldsRef.current).eq("id", id).single();
          if (fetchError || !data) throw new Error("The view-once message was saved, but could not be loaded into the chat. Refresh the conversation.");
          merge([normalizeMessage(data as unknown as Partial<ChatMessage> & Record<string, unknown>)]);
        } else {
          await insert({ room_id: roomId, user_id: userId, kind, media_path: uploadedPath, media_mime: mediaMimeType(file, kind) || null,
            message: caption.trim().slice(0, MAX_MESSAGE_LENGTH), ...(replyTo ? { reply_to_message_id: replyTo } : {}) });
          messageSaved = true;
        }
        setUploadProgress(100);
        return true;
      } catch (e) {
        if (uploadedPath && !messageSaved) {
          // Avoid orphaned uploads when the database rejects the message row.
          void supabase.storage.from(bucket).remove([uploadedPath]);
        }
        setSendError(e instanceof Error ? e.message : "Upload failed. Check the connection and retry.");
        return false;
      } finally {
        setSending(false);
        setTimeout(() => setUploadProgress(0), 1200);
      }
    },
    [roomId, insert, merge],
  );

  const openViewOnce = useCallback(async (messageId: string) => {
    if (!featuresAvailable) throw new Error("View-once messages need the WAVE database update first.");
    const { data, error } = await supabase.rpc("open_view_once_message", { p_message_id: messageId });
    if (error) throw new Error(error.message.includes("ALREADY_OPENED") ? "This message has already been opened." : "Could not open this message. It may already have been viewed.");
    const payload = data as unknown as ViewOncePayload;
    if (payload?.already_opened) throw new Error("This message has already been opened.");
    await syncLatest();
    return payload;
  }, [featuresAvailable, syncLatest]);

  const toggleReaction = useCallback(async (messageId: string, emoji: string) => {
    if (!featuresAvailable) throw new Error("Reactions need the WAVE database update first.");
    if (!ALLOWED_REACTIONS.includes(emoji as (typeof ALLOWED_REACTIONS)[number])) throw new Error("Unsupported reaction.");
    const lock = messageId + ":" + emoji;
    if (reactionLocks.current.has(lock)) return;
    reactionLocks.current.add(lock);
    try {
      const { data, error } = await supabase.rpc("toggle_room_message_reaction", { p_message_id: messageId, p_emoji: emoji });
      if (error) throw new Error("Could not save reaction. Try again.");
      setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, reactions: (data ?? {}) as unknown as Record<string, string[]> } : m));
    } finally {
      reactionLocks.current.delete(lock);
    }
  }, [featuresAvailable]);

  /** Author-only. The row is cleared server-side first; the files are removed right after (best effort). */
  const deleteForEveryone = useCallback(async (messageId: string) => {
    if (!deleteAvailable) throw new Error("Delete for everyone needs the WAVE database update first.");
    const { data, error } = (await supabase.rpc("delete_room_message_for_everyone" as never, { p_message_id: messageId } as never)) as unknown as {
      data: unknown;
      error: { message: string } | null;
    };
    if (error) {
      if (error.message.includes("NOT_AUTHOR")) throw new Error("You can only delete your own messages.");
      if (error.message.includes("MESSAGE_NOT_FOUND")) throw new Error("This message no longer exists.");
      throw new Error("Could not delete this message. Try again.");
    }
    const payload = (data ?? {}) as DeletePayload;
    const deletedAt = new Date().toISOString();
    setMessages((prev) => prev.map((m) => m.id === messageId
      ? { ...m, deleted_at: m.deleted_at ?? deletedAt, deleted_by: m.user_id, message: "", media_path: null, media_mime: null, reactions: {} }
      : m));
    const removeFiles = (bucket: string, path: string | null | undefined) => {
      if (path) void supabase.storage.from(bucket).remove([path]).catch(() => undefined);
    };
    removeFiles("chat-media", payload.media_path);
    removeFiles("chat-view-once", payload.view_once_media_path);
  }, [deleteAvailable]);

  /** Mark the partner's messages delivered, and read when the conversation is actually visible. */
  const markSeen = useCallback(
    async (read: boolean) => {
      await supabase.rpc("mark_room_messages" as never, { p_room_id: roomId, p_read: read } as never);
    },
    [roomId],
  );

  return {
    messages,
    featuresAvailable,
    featureSchemaMissing,
    deleteAvailable,
    deleteForEveryone,
    uploadProgress,
    loading,
    loadError,
    hasMore,
    loadingOlder,
    loadOlder,
    sending,
    sendError,
    setSendError,
    send,
    sendMedia,
    openViewOnce,
    toggleReaction,
    typingUser,
    notifyTyping,
    markSeen,
    refs,
    ensureLoaded,
  };
}
