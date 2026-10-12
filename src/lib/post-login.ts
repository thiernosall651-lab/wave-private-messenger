/**
 * Remember which room an invite link pointed to when the visitor is not signed in,
 * so we can send them there after login instead of the dashboard.
 */
const KEY = "wave-after-login";
const MAX_AGE_MS = 60 * 60 * 1000;
const ROOM_PATH = /^\/room\/([A-Za-z0-9-]{3,32})\/?$/;
const CODE = /^[A-Za-z0-9-]{3,32}$/;

export function rememberRoomDestination(pathname: string): void {
  if (typeof window === "undefined") return;
  const match = ROOM_PATH.exec(pathname);
  if (!match) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ code: match[1], at: Date.now() }));
  } catch {
    /* storage can be unavailable (private mode): login still works, just lands on the dashboard */
  }
}

/** Returns the remembered room code once (then forgets it), or null. */
export function consumeRoomDestination(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { code?: unknown; at?: unknown };
    if (typeof parsed.code !== "string" || !CODE.test(parsed.code)) return null;
    if (typeof parsed.at !== "number" || Date.now() - parsed.at > MAX_AGE_MS) return null;
    return parsed.code;
  } catch {
    return null;
  }
}
