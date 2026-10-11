import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Camera, Check, CheckCheck, Eye, EyeOff, Image as ImageIcon, LoaderCircle, Mic, Plus, Reply, Send, Square, Trash2, Video, X } from "lucide-react";
import { toast } from "sonner";

import { MAX_MESSAGE_LENGTH, useRoomChat, type ChatMessage } from "@/hooks/useRoomChat";
import { chatMediaUrl, MAX_VOICE_SECONDS, validateMedia, type MediaKind } from "@/lib/chat-media";
import { Avatar } from "@/components/Avatar";
import { AudioMessage, ImageMessage, Lightbox, VideoMessage } from "@/components/ChatMedia";

type Props = {
  roomId: string;
  selfId: string;
  selfName: string;
  peerName: string | null;
  peerAvatar: string | null;
  wallpaper: string;
  onTypingChange?: (typing: boolean) => void;
};

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
type Pending = { kind: MediaKind; file: Blob; url: string };
type OnceViewer = { kind: "text" | MediaKind; content: string; url: string | null };

export function RoomChat({ roomId, selfId, selfName, peerName, peerAvatar, wallpaper, onTypingChange }: Props) {
  const {
    messages,
    featuresAvailable,
    featureSchemaMissing,
    uploadProgress,
    openViewOnce,
    toggleReaction,
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
    typingUser,
    notifyTyping,
    markSeen,
    refs,
    ensureLoaded,
  } = useRoomChat(roomId);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [viewOnceMode, setViewOnceMode] = useState(false);
  useEffect(() => {
    if (sendError) toast.error(sendError, { duration: 12000 });
  }, [sendError]);
  const [onceViewer, setOnceViewer] = useState<OnceViewer | null>(null);
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const submitLockRef = useRef(false);
  const nameOf = (uid: string) => (uid === selfId ? "You" : peerName ?? "Friend");
  const findMsg = (id: string) => messages.find((m) => m.id === id) ?? refs[id] ?? null;

  const startReply = (m: ChatMessage) => {
    setReplyTo(m);
    setActionsFor(null);
    setTimeout(() => textRef.current?.focus(), 0);
  };

  const jumpTo = async (id: string) => {
    const flash = () => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-mid="${id}"]`);
      if (!el) return false;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.remove("msg-flash");
      void el.offsetWidth;
      el.classList.add("msg-flash");
      setTimeout(() => el.classList.remove("msg-flash"), 1500);
      return true;
    };
    if (flash()) return;
    const ok = await ensureLoaded(id);
    if (!ok) {
      setSendError("The original message is no longer available.");
      return;
    }
    setTimeout(flash, 80);
  };

  const openOnce = async (message: ChatMessage) => {
    if (!message.view_once || message.viewed_at || message.user_id === selfId) return;
    if (!featuresAvailable) {
      setSendError("View-once messages need the WAVE database update first.");
      return;
    }
    try {
      const payload = await openViewOnce(message.id);
      const kind = payload.kind || message.kind;
      let url: string | null = null;
      if (payload.media_path) {
        url = await chatMediaUrl(payload.media_path, 10 * 60, "chat-view-once");
        if (!url) throw new Error("The message was opened, but its media could not be loaded. Ask your friend to resend it.");
      }
      setOnceViewer({ kind, content: payload.content ?? "", url });
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Could not open this message.");
    }
  };

  const reactToMessage = async (messageId: string, emoji: string) => {
    try {
      await toggleReaction(messageId, emoji);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Could not save reaction.");
    }
  };

  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [menu, setMenu] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [accept, setAccept] = useState("image/*");
  const prependAnchor = useRef<number | null>(null);

  const peerTyping = !!typingUser && typingUser !== selfId;
  useEffect(() => onTypingChange?.(peerTyping), [peerTyping, onTypingChange]);

  const scrollDown = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  const lastId = messages[messages.length - 1]?.id;
  const firstId = messages[0]?.id;
  useEffect(scrollDown, [lastId, peerTyping, pending, scrollDown]);

  // When earlier messages are prepended, keep the user's reading position.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && prependAnchor.current !== null) {
      el.scrollTop += el.scrollHeight - prependAnchor.current;
      prependAnchor.current = null;
    }
  }, [firstId]);

  const showOlder = () => {
    prependAnchor.current = listRef.current?.scrollHeight ?? null;
    void loadOlder();
  };

  // Keep newest messages visible when the mobile keyboard resizes the viewport.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    vv.addEventListener("resize", scrollDown);
    return () => vv.removeEventListener("resize", scrollDown);
  }, [scrollDown]);

  // Delivered / read receipts: read only when this tab is actually visible.
  const unseen = messages.some((m) => m.user_id !== selfId && (!m.read_at || !m.delivered_at));
  useEffect(() => {
    if (!unseen) return;
    const run = () => void markSeen(document.visibilityState === "visible" && document.hasFocus());
    run();
    document.addEventListener("visibilitychange", run);
    window.addEventListener("focus", run);
    return () => {
      document.removeEventListener("visibilitychange", run);
      window.removeEventListener("focus", run);
    };
  }, [unseen, messages.length, markSeen, selfId]);

  useEffect(() => () => {
    if (pending) URL.revokeObjectURL(pending.url);
  }, [pending]);

  const pick = (kind: MediaKind, file: Blob) => {
    const err = validateMedia(kind, file);
    if (err) {
      setSendError(err);
      return;
    }
    setSendError(null);
    setPending({ kind, file, url: URL.createObjectURL(file) });
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const name = f.name.toLowerCase();
    const knownVideoExtension = /\.(mp4|m4v|mov|webm|mkv|avi|3gp|mpeg|mpg|mts|m2ts)$/i.test(name);
    const kind: MediaKind = f.type.toLowerCase().startsWith("video/") || knownVideoExtension ? "video" : "image";
    pick(kind, f);
  };

  const openGallery = (a: string) => {
    setAccept(a);
    setMenu(false);
    const input = galleryRef.current;
    if (input) {
      input.accept = a;
      input.click();
    }
  };

  const submit = async () => {
    if (sending || submitLockRef.current) return;
    submitLockRef.current = true;
    try {
      if (pending) {
        const ok = await sendMedia(selfId, pending.kind, pending.file, text, replyTo?.id ?? null, viewOnceMode);
        if (ok) {
          setPending(null);
          setText("");
          setReplyTo(null);
          setViewOnceMode(false);
        }
        return;
      }
      if (!text.trim()) return;
      const ok = await send(selfId, text, replyTo?.id ?? null, viewOnceMode);
      if (ok) {
        setText("");
        setReplyTo(null);
        setViewOnceMode(false);
      }
    } finally {
      submitLockRef.current = false;
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  // Pasted images become a normal photo attachment; anything else keeps the default text paste.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const item = [...e.clipboardData.items].find((i) => i.kind === "file" && i.type.startsWith("image/"));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    pick("image", file);
  };

  const tooLong = text.length > MAX_MESSAGE_LENGTH;
  const lastOwnId = [...messages].reverse().find((m) => m.user_id === selfId)?.id;

  return (
    <section className="flex min-h-0 w-full min-w-0 max-w-full flex-1 flex-col overflow-hidden" aria-label="Conversation">
      <div ref={listRef} className={`${wallpaper} flex min-h-0 w-full min-w-0 max-w-full flex-1 flex-col gap-1 overflow-x-hidden overflow-y-auto px-3 py-4`}>
        {hasMore && !loading && (
          <button
            onClick={showOlder}
            disabled={loadingOlder}
            className="mx-auto mb-2 rounded-full bg-secondary/80 px-3 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            {loadingOlder ? "Loading..." : "Load earlier messages"}
          </button>
        )}
        {loading && messages.length === 0 && <p className="m-auto text-xs text-muted-foreground">Loading messages...</p>}
        {loadError && <p className="m-auto text-xs text-destructive">{loadError}</p>}
        {!loading && !loadError && messages.length === 0 && (
          <p className="m-auto rounded-full bg-secondary/70 px-3 py-1 text-xs text-muted-foreground">No messages yet. Say hi!</p>
        )}
        {messages.map((m, i) => (
          <Bubble
            key={m.id}
            m={m}
            own={m.user_id === selfId}
            firstInGroup={messages[i - 1]?.user_id !== m.user_id}
            lastInGroup={messages[i + 1]?.user_id !== m.user_id}
            name={m.user_id === selfId ? selfName : peerName ?? "Friend"}
            peerAvatar={peerAvatar}
            showStatus={m.id === lastOwnId}
            onOpen={setLightbox}
            quoted={m.reply_to_message_id ? findMsg(m.reply_to_message_id) : undefined}
            quotedName={(q) => nameOf(q.user_id)}
            onJump={(id) => void jumpTo(id)}
            actionsOpen={actionsFor === m.id}
            onActions={(open) => setActionsFor(open ? m.id : null)}
            selfId={selfId}
            onOpenOnce={(message) => void openOnce(message)}
            onReact={(messageId, emoji) => {
              void reactToMessage(messageId, emoji);
              setActionsFor(null);
            }}
            onReply={() => startReply(m)}
          />
        ))}
        {peerTyping && (
          <div className="msg-in mt-1 flex items-end gap-2 self-start">
            <Avatar path={peerAvatar} name={peerName ?? "Friend"} size={24} />
            <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm bg-secondary px-3 py-2.5" aria-label={`${peerName ?? "Friend"} is typing`}>
              {[0, 1, 2].map((d) => (
                <span key={d} className="typing-dot h-1.5 w-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: `${d * 0.15}s` }} />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="relative z-20 min-w-0 max-w-full overflow-x-clip border-t border-border bg-card px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
        {featureSchemaMissing && (
          <p className="mb-2 text-center text-[11px] text-muted-foreground">One-time messages and reactions will activate after the WAVE database migration is applied.</p>
        )}
        {replyTo && (
          <div className="msg-in mb-2 flex items-center gap-2 rounded-xl border-l-4 border-primary bg-secondary py-1.5 pl-3 pr-1.5">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1 text-[11px] font-medium text-primary">
                <Reply className="h-3 w-3" /> Replying to {nameOf(replyTo.user_id)}
              </p>
              <p className="truncate text-xs text-muted-foreground">{snippet(replyTo)}</p>
            </div>
            <button onClick={() => setReplyTo(null)} aria-label="Cancel reply" className="rounded-full p-1.5 hover:bg-muted">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {pending && (
          <div className="msg-in mb-2 flex min-w-0 flex-wrap items-center gap-3 rounded-xl bg-secondary p-2">
            {pending.kind === "image" && <img src={pending.url} alt="Preview" className="h-16 w-16 rounded-lg object-cover" />}
            {pending.kind === "video" && <video src={pending.url} className="h-16 w-16 rounded-lg object-cover" muted playsInline />}
            {pending.kind === "audio" && <audio src={pending.url} controls className="h-10 flex-1" />}
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {sending ? (pending.kind === "video" ? "Uploading " + uploadProgress + "%" : "Sending...") : pending.kind === "audio" ? "" : pending.kind === "image" ? "Photo ready to send" : "Video ready to send"}
            </span>
            <button
              type="button"
              onPointerUp={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void submit();
              }}
              onClick={(event) => {
                // Pointer clicks are handled on pointerup; detail=0 preserves keyboard/screen-reader activation.
                if (event.detail === 0) void submit();
              }}
              disabled={sending}
              aria-label={sending ? "Sending attachment" : pending.kind === "image" ? "Send photo" : pending.kind === "video" ? "Send video" : "Send voice message"}
              className="relative z-40 flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground touch-manipulation disabled:opacity-60"
            >
              {sending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {sending ? (pending.kind === "video" ? uploadProgress + "%" : "Sending") : "Send"}
            </button>
            <button type="button" onClick={() => setPending(null)} disabled={sending} aria-label="Cancel attachment" className="relative z-40 shrink-0 rounded-full p-1.5 hover:bg-muted disabled:opacity-40">
              <X className="h-4 w-4" />
            </button>
            {sendError && (
              <div role="alert" aria-live="assertive" className="w-full basis-full rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive [overflow-wrap:anywhere]">
                {sendError}
              </div>
            )}
          </div>
        )}

        <div className="relative flex min-w-0 max-w-full items-end gap-2">
          <button
            type="button"
            onClick={() => setMenu((v) => !v)}
            aria-label="Add photo or video"
            aria-expanded={menu}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground transition-transform ${menu ? "rotate-45" : ""}`}
          >
            <Plus className="h-5 w-5" />
          </button>
          {menu && (
            <div className="msg-in absolute bottom-14 left-0 z-30 flex min-w-36 flex-col overflow-hidden rounded-xl border border-border bg-popover text-sm shadow-lg">
              <button onClick={() => openGallery("image/*")} className="flex items-center gap-2 px-4 py-2.5 hover:bg-secondary">
                <ImageIcon className="h-4 w-4 text-primary" /> Photo
              </button>
              <button onClick={() => openGallery("video/*")} className="flex items-center gap-2 px-4 py-2.5 hover:bg-secondary">
                <Video className="h-4 w-4 text-primary" /> Video
              </button>
              <button
                onClick={() => {
                  setMenu(false);
                  cameraRef.current?.click();
                }}
                className="flex items-center gap-2 px-4 py-2.5 hover:bg-secondary"
              >
                <Camera className="h-4 w-4 text-primary" /> Camera
              </button>
            </div>
          )}
          <input ref={galleryRef} type="file" accept={accept} className="hidden" onChange={onFile} />
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFile} />

          <button
            type="button"
            onClick={() => setViewOnceMode((current) => !current)}
            aria-label={viewOnceMode ? "Turn off view-once mode" : "Send as view once"}
            aria-pressed={viewOnceMode}
            title={viewOnceMode ? "View-once mode enabled" : featureSchemaMissing ? "View-once mode: database support may be missing" : "View once"}
            className={"flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-35 " + (viewOnceMode ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground")}
          >
            {viewOnceMode ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
          </button>

          <textarea
            ref={textRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (e.target.value) notifyTyping(selfId);
            }}
            onKeyDown={onKey}
            onPaste={onPaste}
            onFocus={() => setTimeout(scrollDown, 300)}
            rows={1}
            placeholder={pending && pending.kind !== "audio" ? "Add a caption..." : "Message"}
            aria-label="Message"
            className="max-h-32 min-h-11 min-w-0 flex-1 resize-none rounded-2xl border border-border bg-background px-4 py-2.5 text-base outline-none focus:border-primary sm:text-sm"
          />

          {text.trim() || pending ? (
            <button
              type="button"
              onPointerUp={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void submit();
              }}
              onClick={(event) => {
                // Pointer clicks are handled on pointerup; detail=0 preserves keyboard/screen-reader activation.
                if (event.detail === 0) void submit();
              }}
              disabled={sending || tooLong}
              aria-label={sending ? "Sending attachment" : pending ? "Send attachment" : "Send message"}
              aria-busy={sending}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform active:scale-90 disabled:opacity-60"
            >
              {sending ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
            </button>
          ) : (
            <VoiceButton onDone={(blob) => pick("audio", blob)} onError={setSendError} />
          )}
        </div>
        <div className="mt-1 flex min-w-0 max-w-full flex-wrap items-start justify-between gap-1 px-1">
          {sendError ? (
            <div role="alert" aria-live="assertive" className="w-full rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive [overflow-wrap:anywhere]">
              {sendError}
            </div>
          ) : tooLong ? (
            <span className="text-xs text-destructive">Message is too long.</span>
          ) : null}
          {text.length > 0 && (
            <span className={tooLong ? "text-destructive" : "text-muted-foreground"}>
              {text.length}/{MAX_MESSAGE_LENGTH}
            </span>
          )}
        </div>
      </div>
      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
      {onceViewer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4" role="dialog" aria-modal="true" aria-label="View-once message">
          <button onClick={() => setOnceViewer(null)} aria-label="Close view-once message" className="absolute right-4 top-4 rounded-full bg-secondary p-2">
            <X className="h-5 w-5" />
          </button>
          <div className="max-h-full max-w-full overflow-auto rounded-xl bg-card p-3">
            {onceViewer.kind === "text" && <p className="max-w-xl whitespace-pre-wrap break-words text-base">{onceViewer.content}</p>}
            {onceViewer.kind === "image" && onceViewer.url && <img src={onceViewer.url} alt="View-once photo" className="fade-img max-h-[80dvh] max-w-full rounded-xl object-contain" />}
            {onceViewer.kind === "video" && onceViewer.url && <video src={onceViewer.url} controls playsInline autoPlay className="max-h-[80dvh] max-w-full rounded-xl bg-background" />}
            {onceViewer.kind === "audio" && onceViewer.url && <audio src={onceViewer.url} controls autoPlay className="w-full" />}
            {onceViewer.kind !== "text" && onceViewer.content && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{onceViewer.content}</p>}
          </div>
        </div>
      )}
    </section>
  );
}

function Bubble({
  m,
  own,
  firstInGroup,
  lastInGroup,
  name,
  peerAvatar,
  showStatus,
  onOpen,
  quoted,
  quotedName,
  onJump,
  actionsOpen,
  onActions,
  onReply,
  selfId,
  onOpenOnce,
  onReact,
}: {
  m: ChatMessage;
  own: boolean;
  firstInGroup: boolean;
  lastInGroup: boolean;
  name: string;
  peerAvatar: string | null;
  showStatus: boolean;
  onOpen: (u: string) => void;
  quoted: ChatMessage | null | undefined;
  quotedName: (q: ChatMessage) => string;
  onJump: (id: string) => void;
  actionsOpen: boolean;
  onActions: (open: boolean) => void;
  onReply: () => void;
  selfId: string;
  onOpenOnce: (message: ChatMessage) => void;
  onReact: (messageId: string, emoji: string) => void;
}) {
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current);
    press.current = null;
  };
  const media = m.kind !== "text" && m.media_path;
  const shape = own
    ? `rounded-2xl ${lastInGroup ? "rounded-br-sm" : ""} bg-primary text-primary-foreground`
    : `rounded-2xl ${lastInGroup ? "rounded-bl-sm" : ""} bg-secondary text-foreground`;
  return (
    <div
      data-mid={m.id}
      className={`msg-in group relative flex min-w-0 max-w-[82%] items-end gap-2 ${own ? "self-end flex-row-reverse" : "self-start"} ${firstInGroup ? "mt-2" : ""}`}
      onTouchStart={() => {
        cancelPress();
        press.current = setTimeout(() => {
          onActions(true);
          navigator.vibrate?.(15);
        }, 450);
      }}
      onTouchEnd={cancelPress}
      onTouchMove={cancelPress}
      onContextMenu={(e) => {
        e.preventDefault();
        onActions(true);
      }}
    >
      {!own && (lastInGroup ? <Avatar path={peerAvatar} name={name} size={24} /> : <span className="w-6 shrink-0" />)}
      <div className={`flex min-w-0 max-w-full flex-col ${own ? "items-end" : "items-start"}`}>
        {!own && firstInGroup && <span className="mb-0.5 ml-1 text-[11px] font-medium text-primary">{name}</span>}
        <div className={`min-w-0 max-w-full overflow-hidden ${shape} ${media && m.kind !== "audio" ? "p-1" : ""}`}>
          {m.reply_to_message_id && (
            <button
              type="button"
              onClick={() => quoted && onJump(quoted.id)}
              className={`m-1 mb-0 block w-[calc(100%-0.5rem)] min-w-0 max-w-full overflow-hidden rounded-lg border-l-4 px-2 py-1 text-left ${
                own ? "border-primary-foreground/70 bg-primary-foreground/15" : "border-primary bg-background/40"
              }`}
            >
              {quoted ? (
                <>
                  <span className={`block truncate text-[11px] font-medium ${own ? "" : "text-primary"}`}>↩ {quotedName(quoted)}</span>
                  <span className="block truncate text-xs opacity-80">{snippet(quoted)}</span>
                </>
              ) : (
                <span className="block text-xs italic opacity-70">{quoted === null ? "Original message unavailable" : "Loading..."}</span>
              )}
            </button>
          )}
          {m.view_once ? (
            m.viewed_at ? (
              <span className="block px-3 py-2 text-xs opacity-80">Opened</span>
            ) : own ? (
              <span className="block px-3 py-2 text-xs opacity-80">
                {m.kind === "image" ? "Photo" : m.kind === "video" ? "Video" : m.kind === "audio" ? "Voice message" : "Message"} · View once
              </span>
            ) : (
              <button type="button" onClick={() => onOpenOnce(m)} className="flex items-center gap-2 px-3 py-3 text-sm font-medium">
                <Eye className="h-4 w-4" /> Tap to view once
              </button>
            )
          ) : (
            <>
              {m.kind === "image" && m.media_path && <ImageMessage path={m.media_path} onOpen={onOpen} />}
              {m.kind === "video" && m.media_path && <VideoMessage path={m.media_path} />}
              {m.kind === "audio" && m.media_path && <AudioMessage path={m.media_path} own={own} />}
              {m.message && (
                <p className={`max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm ${media ? "px-2 py-1.5" : "px-3 py-2"}`}>{m.message}</p>
              )}
            </>
          )}
        </div>
        {Object.entries(m.reactions ?? {}).filter(([, users]) => Array.isArray(users) && users.length > 0).length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {Object.entries(m.reactions ?? {}).filter(([, users]) => Array.isArray(users) && users.length > 0).map(([emoji, users]) => (
              <button key={emoji} type="button" onClick={() => onReact(m.id, emoji)} aria-label={emoji + " reaction, " + users.length + " people"}
                className={"rounded-full border px-2 py-0.5 text-xs transition-colors " + (users.includes(selfId) ? "border-primary bg-primary/15" : "border-border bg-card")}>
                {emoji} {users.length}
              </button>
            ))}
          </div>
        )}
        {actionsOpen && (
          <div className="msg-in mt-1 flex max-w-full flex-wrap items-center gap-1 rounded-full border border-border bg-popover p-1 text-xs shadow-lg">
            {["❤️", "😂", "😮", "😢", "👍", "🙏", "🔥", "💯"].map((emoji) => (
              <button key={emoji} type="button" onClick={() => onReact(m.id, emoji)} aria-label={"React with " + emoji} className="rounded-full px-1.5 py-1.5 text-base hover:bg-secondary">{emoji}</button>
            ))}
            <button onClick={onReply} className="flex items-center gap-1 rounded-full px-3 py-1.5 hover:bg-secondary">
              <Reply className="h-3.5 w-3.5 text-primary" /> Reply
            </button>
            <button onClick={() => onActions(false)} aria-label="Close" className="rounded-full p-1.5 hover:bg-secondary">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {(lastInGroup || showStatus) && (
          <span className="mt-0.5 flex items-center gap-1 px-1 text-[10px] text-muted-foreground">
            {timeFmt.format(new Date(m.created_at))}
            {own && <Receipt m={m} />}
          </span>
        )}
      </div>
      <button
        onClick={onReply}
        aria-label="Reply"
        className="mb-5 hidden shrink-0 rounded-full p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-foreground focus:opacity-100 group-hover:opacity-100 sm:block"
      >
        <Reply className="h-4 w-4" />
      </button>
    </div>
  );
}

function snippet(m: ChatMessage) {
  if (m.kind === "image") return `📷 ${m.message || "Photo"}`;
  if (m.kind === "video") return `🎥 ${m.message || "Video"}`;
  if (m.kind === "audio") return "🎤 Voice message";
  return m.message;
}

function Receipt({ m }: { m: ChatMessage }) {
  if (m.read_at) return <CheckCheck className="h-3.5 w-3.5 text-primary transition-colors" aria-label="Read" />;
  if (m.delivered_at) return <CheckCheck className="h-3.5 w-3.5 transition-colors" aria-label="Delivered" />;
  return <Check className="h-3.5 w-3.5" aria-label="Sent" />;
}

function VoiceButton({ onDone, onError }: { onDone: (b: Blob) => void; onError: (e: string | null) => void }) {
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [secs, setSecs] = useState(0);
  const chunks = useRef<Blob[]>([]);
  const cancelled = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopAll = (r: MediaRecorder) => {
    if (timer.current) clearInterval(timer.current);
    if (r.state !== "inactive") r.stop();
  };

  useEffect(() => () => {
    if (rec) {
      cancelled.current = true;
      stopAll(rec);
    }
  }, [rec]);

  const start = async () => {
    onError(null);
    if (typeof MediaRecorder === "undefined") {
      onError("Voice messages aren't supported in this browser.");
      return;
    }
    let stream: MediaStream;
    try {
      // Separate, short-lived mic stream — independent from the live call.
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onError("Microphone permission is needed to record a voice message.");
      return;
    }
    const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
    chunks.current = [];
    cancelled.current = false;
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      setRec(null);
      setSecs(0);
      if (!cancelled.current && chunks.current.length) {
        onDone(new Blob(chunks.current, { type: (r.mimeType || "audio/webm").split(";")[0] ?? "audio/webm" }));
      }
    };
    r.start();
    setRec(r);
    setSecs(0);
    timer.current = setInterval(() => {
      setSecs((s) => {
        if (s + 1 >= MAX_VOICE_SECONDS) stopAll(r);
        return s + 1;
      });
    }, 1000);
  };

  if (rec) {
    return (
      <div className="msg-in absolute inset-0 flex items-center gap-2 rounded-full bg-card">
        <button
          onClick={() => {
            cancelled.current = true;
            stopAll(rec);
          }}
          aria-label="Cancel recording"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-secondary text-destructive"
        >
          <Trash2 className="h-5 w-5" />
        </button>
        <span className="flex flex-1 items-center gap-2 text-sm">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-destructive" />
          Recording {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")} / 1:00
        </span>
        <button
          onClick={() => stopAll(rec)}
          aria-label="Stop recording"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground"
        >
          <Square className="h-4 w-4" />
        </button>
      </div>
    );
  }
  return (
    <button
      onClick={() => void start()}
      aria-label="Record voice message"
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground active:scale-90"
    >
      <Mic className="h-5 w-5" />
    </button>
  );
}
