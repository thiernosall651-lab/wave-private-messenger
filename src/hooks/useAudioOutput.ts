import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type AudioOutputMode = "speaker" | "earpiece";
/** route = le téléphone permet de choisir l'écouteur ; volume = seulement baisser le volume ; none = ordinateur */
export type AudioOutputCapability = "route" | "volume" | "none";

const STORAGE_KEY = "wave-audio-output";
const QUIET_VOLUME = 0.3;

type SinkAudio = HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
type SessionNav = Navigator & { audioSession?: { type: string } };

const isPhone = () =>
  typeof navigator !== "undefined" && (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.matchMedia?.("(pointer: coarse)").matches === true);

/**
 * Bouton « haut-parleur / écouteur » façon WhatsApp.
 * - iPhone (Safari) : session audio « play-and-record » = écouteur.
 * - Navigateur qui expose un écouteur (setSinkId) : on le sélectionne.
 * - Sinon (Android Chrome) : le navigateur ne laisse pas choisir l'écouteur → mode discret (volume réduit).
 */
export function useAudioOutput(audioRef: RefObject<HTMLAudioElement | null>, active: boolean) {
  const [capability, setCapability] = useState<AudioOutputCapability>("none");
  const [mode, setMode] = useState<AudioOutputMode>("speaker");
  const earpieceId = useRef<string | null>(null);

  useEffect(() => {
    if (!isPhone()) return;
    let alive = true;
    const finish = (cap: AudioOutputCapability) => {
      if (!alive) return;
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(STORAGE_KEY);
      } catch {
        saved = null;
      }
      setMode(saved === "speaker" || saved === "earpiece" ? saved : cap === "route" ? "earpiece" : "speaker");
      setCapability(cap);
    };
    void (async () => {
      if ((navigator as SessionNav).audioSession) return finish("route");
      const el = audioRef.current as SinkAudio | null;
      if (el?.setSinkId && navigator.mediaDevices?.enumerateDevices) {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const ear = devices.find((d) => d.kind === "audiooutput" && /earpiece|receiver|handset/i.test(d.label));
          if (ear) {
            earpieceId.current = ear.deviceId;
            return finish("route");
          }
        } catch {
          /* on retombe sur le mode volume */
        }
      }
      finish("volume");
    })();
    return () => {
      alive = false;
    };
  }, [audioRef]);

  useEffect(() => {
    if (capability === "none") return;
    const el = audioRef.current as SinkAudio | null;
    const session = (navigator as SessionNav).audioSession;
    if (capability === "route") {
      if (session) {
        try {
          session.type = mode === "earpiece" ? "play-and-record" : "playback";
        } catch {
          /* ignoré : appareil non compatible */
        }
      } else if (el?.setSinkId && earpieceId.current) {
        void el.setSinkId(mode === "earpiece" ? earpieceId.current : "").catch(() => undefined);
      }
    } else if (el) {
      el.volume = mode === "earpiece" ? QUIET_VOLUME : 1;
    }
  }, [capability, mode, active, audioRef]);

  const toggle = useCallback(() => {
    setMode((current) => {
      const next: AudioOutputMode = current === "speaker" ? "earpiece" : "speaker";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* stockage indisponible */
      }
      return next;
    });
  }, []);

  return { capability, mode, toggle };
}
