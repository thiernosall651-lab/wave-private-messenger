import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { chatMediaUrl } from "@/lib/chat-media";
import { listMyRooms, type RoomListItem } from "@/lib/wave-api";

/** Heure du dernier message, façon WhatsApp : l'heure aujourd'hui, « Yesterday », le jour, puis la date. */
export function formatListTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function roomPreview(r: RoomListItem): string {
  if (!r.other_name && !r.last_message_at) return "Waiting for a friend — share the code";
  if (!r.last_message_at) return "No messages yet";
  const prefix = r.last_message_mine ? "You: " : "";
  if (r.last_message_deleted) return `${prefix}🚫 Message deleted`;
  if (r.last_message_view_once) return `${prefix}🔒 View once`;
  const caption = (r.last_message_preview ?? "").trim();
  switch (r.last_message_kind) {
    case "image": return `${prefix}📷 ${caption || "Photo"}`;
    case "video": return `${prefix}🎥 ${caption || "Video"}`;
    case "audio": return `${prefix}🎤 Voice message`;
    default: return `${prefix}${caption}`;
  }
}

function RoomAvatar({ path, name }: { path: string | null; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (path) void chatMediaUrl(path, 3600, "avatars").then((u) => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [path]);
  if (url) return <img src={url} alt="" width={48} height={48} loading="lazy" className="size-12 shrink-0 rounded-full object-cover" />;
  return (
    <div aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-full bg-secondary font-display text-lg font-semibold text-secondary-foreground">
      {(name.trim()[0] ?? "?").toUpperCase()}
    </div>
  );
}

export function RoomList({ userId }: { userId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queryKey = ["my-rooms", userId];
  const { data: rooms } = useQuery({ queryKey, queryFn: listMyRooms, refetchInterval: 30_000 });

  // Rafraîchit la liste dès qu'un message arrive, est lu ou supprimé.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const channel = supabase
      .channel(`rooms-list-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "room_messages" }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["my-rooms", userId] }), 400);
      })
      .subscribe();
    return () => {
      clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [userId, queryClient]);

  if (!rooms || rooms.length === 0) return null;

  return (
    <section aria-label="Your rooms" className="mt-6">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Your rooms</h2>
      <ul className="wave-panel divide-y divide-border overflow-hidden">
        {rooms.map((r) => {
          const name = r.other_name || "New room";
          const unread = r.unread_count;
          return (
            <li key={r.room_id}>
              <button
                type="button"
                onClick={() => void navigate({ to: "/room/$code", params: { code: r.code } })}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/60"
              >
                <RoomAvatar path={r.other_avatar} name={name} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-semibold">{name}</span>
                    <time dateTime={r.last_message_at ?? undefined} className={`shrink-0 text-xs ${unread > 0 ? "font-semibold text-primary" : "text-muted-foreground"}`}>
                      {formatListTime(r.last_message_at)}
                    </time>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className={`truncate text-sm ${unread > 0 ? "text-foreground" : "text-muted-foreground"}`}>{roomPreview(r)}</span>
                    {unread > 0 && (
                      <span aria-label={`${unread} unread messages`} className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
                        {unread > 99 ? "99+" : unread}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[10px] uppercase tracking-widest text-muted-foreground">{r.code}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
