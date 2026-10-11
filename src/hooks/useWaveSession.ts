import { useCallback, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

export function useWaveSession() {
  const [user, setUser] = useState<User | null>(null);
  const [firstName, setFirstName] = useState<string>("");
  const [nickname, setNickname] = useState<string>("");
  const [avatarPath, setAvatarPath] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;

    const loadProfile = async (id: string, fallback: string) => {
      const { data } = await supabase
        .from("profiles")
        .select("first_name, nickname, avatar_url, status")
        .eq("id", id)
        .maybeSingle();
      if (!active) return;
      const nick = data?.nickname?.trim() || "";
      setNickname(nick);
      setAvatarPath(data?.avatar_url ?? null);
      setStatus(data?.status ?? "");
      setFirstName(nick || data?.first_name?.trim() || fallback || "Friend");
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setUser(session?.user ?? null);
      if (session?.user) {
        const fallback = (session.user.user_metadata?.["first_name"] as string | undefined) ?? "";
        void loadProfile(session.user.id, fallback);
      } else {
        setFirstName("");
        setNickname("");
        setAvatarPath(null);
      }
    });

    void supabase.auth.getUser().then(({ data }) => {
      if (!active) return;
      setUser(data.user ?? null);
      if (data.user) {
        const fallback = (data.user.user_metadata?.["first_name"] as string | undefined) ?? "";
        void loadProfile(data.user.id, fallback);
      }
      setLoading(false);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  return { user, firstName, nickname, avatarPath, status, loading, refresh };
}
