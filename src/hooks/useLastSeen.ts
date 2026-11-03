import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";

/** Signale « je suis là » toutes les minutes tant que l'appli est ouverte et visible. */
export function useHeartbeat(userId: string | undefined) {
  useEffect(() => {
    if (!userId) return;
    const touch = () => {
      if (document.visibilityState === "visible") void supabase.rpc("touch_last_seen" as never);
    };
    touch();
    const id = setInterval(touch, 60_000);
    document.addEventListener("visibilitychange", touch);
    window.addEventListener("focus", touch);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", touch);
      window.removeEventListener("focus", touch);
    };
  }, [userId]);
}

/** Dernière activité de l'autre personne de la salle (null si inconnue). Actif seulement quand elle est hors ligne. */
export function usePeerLastSeen(roomId: string, enabled: boolean): string | null {
  const [seen, setSeen] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      const { data, error } = await supabase.rpc("get_peer_last_seen" as never, { p_room_id: roomId } as never);
      if (alive && !error) setSeen((data as string | null) ?? null);
    };
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [roomId, enabled]);
  return seen;
}
