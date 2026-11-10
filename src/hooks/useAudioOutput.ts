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
          // Ne jamais détacher/rattacher le flux WebRTC lors d'un changement de sortie :
          // Safari iOS peut interrompre la lecture et renégocier la route audio.
          if (el?.srcObject && el.paused) void el.play().catch(() => undefined);
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

/** Résumé technique de la sortie audio du téléphone (à copier/coller pour diagnostiquer un problème d'écouteur). */
export async function describeAudioOutput(el: HTMLAudioElement | null, state: { capability: string; mode: string }): Promise<string> {
  const nav = navigator as SessionNav;
  const sink = el as (HTMLAudioElement & { setSinkId?: unknown; sinkId?: string }) | null;
  const lines = [
    `Appareil: ${navigator.userAgent}`,
    `Mode WAVE: ${state.mode} (${state.capability})`,
    `audioSession: ${nav.audioSession ? `oui, type=${nav.audioSession.type}` : "non"}`,
    `setSinkId: ${sink && "setSinkId" in sink ? `oui (sinkId="${sink.sinkId ?? ""}")` : "non"}`,
  ];
  if (el) {
    const tracks = (el.srcObject as MediaStream | null)?.getAudioTracks() ?? [];
    lines.push(`Lecture: paused=${el.paused} muted=${el.muted} volume=${el.volume}`);
    lines.push(`Piste distante: ${tracks.length ? tracks.map((t) => t.readyState + (t.muted ? "/muted" : "")).join(", ") : "aucune"}`);
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outs = devices.filter((d) => d.kind === "audiooutput");
    const ins = devices.filter((d) => d.kind === "audioinput");
    lines.push(`Sorties audio (${outs.length}): ${outs.map((d) => d.label || "?").join(" | ") || "aucune"}`);
    lines.push(`Entrées audio (${ins.length}): ${ins.map((d) => d.label || "?").join(" | ") || "aucune"}`);
  } catch {
    lines.push("Liste des périphériques: indisponible");
  }
  return lines.join("\n");
}
