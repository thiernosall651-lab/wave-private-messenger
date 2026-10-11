import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

export type PeerProfile = { user_id: string; first_name: string; avatar_url: string | null; status: string | null };

/**
 * Reads the partner's profile via get_room_state. A small Realtime broadcast channel
 * ("profile-changed") triggers instant reloads; polling + focus cover edits made elsewhere.
 */
export function useRoomPeer(roomId: string, selfId: string, presenceKey: string | null) {
  const [peer, setPeer] = useState<PeerProfile | null>(null);
  const chanRef = useRef<RealtimeChannel | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("get_room_state" as never, { p_room_id: roomId } as never);
    if (error || !data) return;
    const list = ((data as { participants?: PeerProfile[] }).participants ?? []) as PeerProfile[];
    setPeer(list.find((p) => p.user_id !== selfId) ?? null);
  }, [roomId, selfId]);

  useEffect(() => {
    void load();
  }, [load, presenceKey]);

  useEffect(() => {
    const ch = supabase
      .channel(`wave-profile:${roomId}`)
      .on("broadcast", { event: "profile-changed" }, ({ payload }) => {
        if ((payload as { userId?: string })?.userId !== selfId) void load();
      })
      .subscribe();
    chanRef.current = ch;
    const id = setInterval(() => void load(), 10000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
      chanRef.current = null;
      void supabase.removeChannel(ch);
    };
  }, [load, roomId, selfId]);

  const announce = useCallback(() => {
    void chanRef.current?.send({ type: "broadcast", event: "profile-changed", payload: { userId: selfId } });
  }, [selfId]);

  return { peer, reload: load, announce };
}
