import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/** Ignore the presence sync that happens right after we open the room. */
const IGNORE_FIRST_MS = 4000;
/** Do not alert again if the peer reconnects within this window. */
const MIN_GAP_MS = 30_000;

type Permission = NotificationPermission | "unsupported";

function chime() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    void ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    [660, 880].forEach((freq, i) => {
      const start = now + i * 0.16;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.32);
    });
    setTimeout(() => void ctx.close().catch(() => {}), 900);
  } catch {
    /* sound is a nice-to-have */
  }
}

/**
 * Tells the user when their friend arrives in the room: chime, toast, vibration,
 * and — when the tab is in the background — a browser notification and a title badge.
 * Works while the app is open (even in another tab). Alerts with the app fully
 * closed need Web Push (separate step).
 */
export function usePeerAlerts({ online, name }: { online: boolean; name: string | null }) {
  const [permission, setPermission] = useState<Permission>("unsupported");
  const mountedAt = useRef(Date.now());
  const wasOnline = useRef(false);
  const lastAlertAt = useRef(0);
  const originalTitle = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    setPermission(Notification.permission);
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden && originalTitle.current !== null) {
        document.title = originalTitle.current;
        originalTitle.current = null;
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    const was = wasOnline.current;
    wasOnline.current = online;
    if (!online || was) return;
    const now = Date.now();
    if (now - mountedAt.current < IGNORE_FIRST_MS) return;
    if (now - lastAlertAt.current < MIN_GAP_MS) return;
    lastAlertAt.current = now;

    const who = name ?? "Your friend";
    chime();
    try {
      navigator.vibrate?.([120, 80, 120]);
    } catch {
      /* noop */
    }
    toast(`${who} is online`);

    if (document.hidden) {
      if (originalTitle.current === null) originalTitle.current = document.title;
      document.title = `● ${who} is online`;
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          const n = new Notification(`${who} is online`, { body: "Open WAVE to talk", tag: "wave-peer-online" });
          n.onclick = () => {
            window.focus();
            n.close();
          };
        } catch {
          /* some mobile browsers only allow notifications from a service worker */
        }
      }
    }
  }, [online, name]);

  const enableNotifications = useCallback(async () => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "granted") {
      toast("Alerts are on");
      return;
    }
    if (Notification.permission === "denied") {
      toast.error("Notifications are blocked in your browser settings.");
      return;
    }
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result === "granted") toast.success("Alerts on — you'll be told when your friend comes online");
  }, []);

  return { permission, enableNotifications };
}
