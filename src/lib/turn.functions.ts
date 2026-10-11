import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type TurnIceServer = { urls: string[]; username?: string; credential?: string };

export const getIceServers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ iceServers: TurnIceServer[] }> => {
    const keyId = process.env["TURN_KEY_ID"];
    const apiToken = process.env["TURN_KEY_API_TOKEN"];
    if (!keyId || !apiToken) return { iceServers: [] };

    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ttl: 86400 }),
        },
      );
      if (!res.ok) {
        console.error("[turn] credential request failed", res.status);
        return { iceServers: [] };
      }
      const data = (await res.json()) as { iceServers?: TurnIceServer[] };
      return { iceServers: Array.isArray(data.iceServers) ? data.iceServers : [] };
    } catch (error) {
      console.error("[turn] credential request error", error);
      return { iceServers: [] };
    }
  });
