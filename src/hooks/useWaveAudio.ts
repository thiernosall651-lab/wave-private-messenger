import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { RTC_CONFIG, loadIceServers, type ConnectionStatus } from "@/lib/webrtc-config";

type SignalPayload = {
  from: string;
  to: string | null;
  kind: "offer" | "answer" | "ice" | "bye" | "restart";
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

type PresenceMeta = { user_id: string; first_name: string };

export type PeerInfo = { userId: string; firstName: string } | null;

type Options = {
  roomId: string;
  selfId: string;
  firstName: string;
};

const RECOVER_COOLDOWN_MS = 4000;
const CONNECT_TIMEOUT_MS = 12000;
const MAX_ATTEMPTS_BEFORE_FAILED = 6;

/**
 * Real WebRTC peer-to-peer audio between exactly two people.
 * Supabase Realtime is used ONLY for signaling + presence — never for audio.
 *
 * Recovery: the lower user id is always the offerer. When audio breaks
 * (connection failed/disconnected, no inbound audio bytes, signaling
 * reconnect), the offerer tears down its single peer connection and sends a
 * fresh offer; the answerer asks for this via a "restart" signal. Only one
 * RTCPeerConnection exists at a time and the same local mic track is reused,
 * so the mute state is preserved.
 */
export function useWaveAudio({ roomId, selfId, firstName }: Options) {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [micEnabled, setMicEnabled] = useState(true);
  const [peer, setPeer] = useState<PeerInfo>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const peerIdRef = useRef<string | null>(null);
  const makingOfferRef = useRef(false);
  const teardownRef = useRef(false);
  const firstNameRef = useRef(firstName);
  const pcCreatedAtRef = useRef(0);
  const lastRecoverRef = useRef(0);
  const attemptsRef = useRef(0);
  const recoverRef = useRef<() => void>(() => {});
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const send = useCallback((payload: SignalPayload) => {
    channelRef.current?.send({ type: "broadcast", event: "signal", payload });
  }, []);

  const closePeerConnection = useCallback(() => {
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
    const pc = pcRef.current;
    pcRef.current = null;
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        /* noop */
      }
    }
    pendingIceRef.current = [];
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
  }, []);

  const ensurePeerConnection = useCallback(
    (remoteId: string) => {
      if (pcRef.current) return pcRef.current;

      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcRef.current = pc;
      pcCreatedAtRef.current = Date.now();

      // Same local track every time → mute state preserved, never duplicated.
      localStreamRef.current?.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current as MediaStream);
      });

      pc.onicecandidate = (event) => {
        if (pcRef.current !== pc) return;
        if (event.candidate) {
          send({ from: selfId, to: remoteId, kind: "ice", candidate: event.candidate.toJSON() });
        }
      };

      pc.ontrack = (event) => {
        if (pcRef.current !== pc) return;
        const [stream] = event.streams;
        if (remoteAudioRef.current && stream) {
          remoteAudioRef.current.srcObject = stream;
          void remoteAudioRef.current.play().catch(() => {
            /* autoplay may need a user gesture; the UI already required one */
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (teardownRef.current || pcRef.current !== pc) return;
        switch (pc.connectionState) {
          case "connected":
            if (disconnectTimerRef.current) {
              clearTimeout(disconnectTimerRef.current);
              disconnectTimerRef.current = null;
            }
            attemptsRef.current = 0;
            setErrorMessage(null);
            setStatus("connected");
            void remoteAudioRef.current?.play().catch(() => {});
            break;
          case "connecting":
            setStatus(attemptsRef.current > 0 ? "reconnecting" : "connecting");
            break;
          case "disconnected":
            setStatus("reconnecting");
            // Give ICE a moment to self-heal, then rebuild.
            if (!disconnectTimerRef.current) {
              disconnectTimerRef.current = setTimeout(() => {
                disconnectTimerRef.current = null;
                if (pcRef.current === pc && pc.connectionState !== "connected") recoverRef.current();
              }, 3000);
            }
            break;
          case "failed":
            recoverRef.current();
            break;
          default:
            break;
        }
      };

      return pc;
    },
    [selfId, send],
  );

  const makeOffer = useCallback(
    async (remoteId: string) => {
      const pc = ensurePeerConnection(remoteId);
      try {
        makingOfferRef.current = true;
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        if (pcRef.current !== pc) return;
        await pc.setLocalDescription(offer);
        send({ from: selfId, to: remoteId, kind: "offer", sdp: pc.localDescription ?? offer });
      } catch {
        setErrorMessage("Could not start the audio connection.");
      } finally {
        makingOfferRef.current = false;
      }
    },
    [ensurePeerConnection, selfId, send],
  );

  // Recovery: rebuild the single peer connection with a fresh negotiation.
  recoverRef.current = () => {
    const remote = peerIdRef.current;
    if (!remote || teardownRef.current || !localStreamRef.current) return;
    const now = Date.now();
    if (now - lastRecoverRef.current < RECOVER_COOLDOWN_MS) return;
    lastRecoverRef.current = now;
    attemptsRef.current += 1;
    if (attemptsRef.current > MAX_ATTEMPTS_BEFORE_FAILED) {
      setStatus("failed");
      setErrorMessage("Audio connection failed. Still retrying...");
    } else {
      setStatus("reconnecting");
    }
    closePeerConnection();
    if (selfId < remote) {
      void makeOffer(remote);
    } else {
      ensurePeerConnection(remote);
      send({ from: selfId, to: remote, kind: "restart" });
    }
  };

  const flushIce = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;
    const queued = pendingIceRef.current;
    pendingIceRef.current = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        /* ignore malformed/duplicate/stale candidates */
      }
    }
  }, []);

  const handleSignal = useCallback(
    async (payload: SignalPayload) => {
      if (payload.from === selfId) return;
      if (payload.to && payload.to !== selfId) return;

      if (payload.kind === "bye") {
        closePeerConnection();
        peerIdRef.current = null;
        setPeer(null);
        setStatus("waiting");
        return;
      }

      if (payload.kind === "restart") {
        // Only the offerer acts on restart requests.
        if (selfId < payload.from) {
          peerIdRef.current = payload.from;
          lastRecoverRef.current = 0;
          recoverRef.current();
        }
        return;
      }

      let pc = ensurePeerConnection(payload.from);

      if (payload.kind === "offer" && payload.sdp) {
        const polite = selfId > payload.from;
        const collision = makingOfferRef.current || pc.signalingState !== "stable";
        if (collision && !polite) return;
        // A new offer on an already-negotiated connection = a fresh session
        // from the peer: drop the stale connection instead of reusing it.
        if (pc.remoteDescription || pc.connectionState === "failed" || pc.connectionState === "closed") {
          const queued = pendingIceRef.current;
          closePeerConnection();
          pc = ensurePeerConnection(payload.from);
          pendingIceRef.current = queued;
        } else if (collision && polite) {
          try {
            await pc.setLocalDescription({ type: "rollback" } as RTCSessionDescriptionInit);
          } catch {
            /* noop */
          }
        }
        peerIdRef.current = payload.from;
        setStatus(attemptsRef.current > 0 ? "reconnecting" : "connecting");
        try {
          await pc.setRemoteDescription(payload.sdp);
          await flushIce();
          const answer = await pc.createAnswer();
          if (pcRef.current !== pc) return;
          await pc.setLocalDescription(answer);
          send({ from: selfId, to: payload.from, kind: "answer", sdp: pc.localDescription ?? answer });
        } catch {
          recoverRef.current();
        }
        return;
      }

      if (payload.kind === "answer" && payload.sdp) {
        if (pc.signalingState !== "have-local-offer") return;
        try {
          await pc.setRemoteDescription(payload.sdp);
          await flushIce();
        } catch {
          recoverRef.current();
        }
        return;
      }

      if (payload.kind === "ice" && payload.candidate) {
        if (pc.remoteDescription) {
          try {
            await pc.addIceCandidate(payload.candidate);
          } catch {
            /* ignore stale candidates */
          }
        } else {
          pendingIceRef.current.push(payload.candidate);
        }
      }
    },
    [closePeerConnection, ensurePeerConnection, flushIce, selfId, send],
  );

  useEffect(() => {
    teardownRef.current = false;
    let cancelled = false;
    let subscribedOnce = false;

    const start = async () => {
      setStatus("requesting-mic");
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
      } catch {
        if (!cancelled) {
          setStatus("mic-denied");
          setErrorMessage("WAVE needs microphone access to connect you.");
        }
        return;
      }
      await loadIceServers();
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      localStreamRef.current = stream;
      setStatus("waiting");

      const channel = supabase.channel(`wave-room:${roomId}`, {
        config: {
          presence: { key: selfId },
          broadcast: { self: false, ack: false },
        },
      });
      channelRef.current = channel;

      channel.on("broadcast", { event: "signal" }, ({ payload }) => {
        void handleSignal(payload as SignalPayload);
      });

      channel.on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<PresenceMeta>();
        const others = Object.entries(state)
          .filter(([key]) => key !== selfId)
          .map(([key, metas]) => ({
            userId: key,
            firstName: metas[0]?.first_name ?? "Friend",
          }));

        const other = others[0] ?? null;
        setPeer(other);

        if (!other) {
          if (peerIdRef.current) {
            closePeerConnection();
            peerIdRef.current = null;
            attemptsRef.current = 0;
            setStatus("waiting");
          }
          return;
        }

        if (peerIdRef.current !== other.userId) {
          closePeerConnection();
          peerIdRef.current = other.userId;
          attemptsRef.current = 0;
          setStatus("connecting");
          if (selfId < other.userId) {
            void makeOffer(other.userId);
          } else {
            ensurePeerConnection(other.userId);
          }
        }
      });

      channel.subscribe(async (state) => {
        if (state === "SUBSCRIBED") {
          setErrorMessage(null);
          await channel.track({ user_id: selfId, first_name: firstNameRef.current } satisfies PresenceMeta);
          // Signaling came back after a drop: re-check audio, rebuild if not connected.
          if (subscribedOnce && peerIdRef.current && pcRef.current?.connectionState !== "connected") {
            lastRecoverRef.current = 0;
            recoverRef.current();
          }
          subscribedOnce = true;
        } else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") {
          setErrorMessage("Lost connection to the signaling service. Reconnecting...");
        }
      });
    };

    void start();

    // Watchdog: detect "online but no audio" and recover automatically.
    let lastBytes = -1;
    let stalls = 0;
    const watchdog = setInterval(async () => {
      if (teardownRef.current || !peerIdRef.current || !localStreamRef.current) return;
      const pc = pcRef.current;
      if (!pc || pc.connectionState !== "connected") {
        lastBytes = -1;
        stalls = 0;
        if (!pc || Date.now() - pcCreatedAtRef.current > CONNECT_TIMEOUT_MS) recoverRef.current();
        return;
      }
      try {
        const stats = await pc.getStats();
        let bytes = 0;
        stats.forEach((r) => {
          const s = r as { type: string; kind?: string; mediaType?: string; bytesReceived?: number };
          if (s.type === "inbound-rtp" && (s.kind ?? s.mediaType) === "audio") bytes += s.bytesReceived ?? 0;
        });
        // A muted peer still sends silent packets, so stalled bytes = broken audio.
        if (lastBytes >= 0 && bytes <= lastBytes) stalls += 1;
        else stalls = 0;
        lastBytes = bytes;
        if (stalls >= 3) {
          stalls = 0;
          lastBytes = -1;
          recoverRef.current();
        }
      } catch {
        /* noop */
      }
    }, 3000);

    return () => {
      cancelled = true;
      teardownRef.current = true;
      clearInterval(watchdog);
      if (channelRef.current) {
        const ch = channelRef.current;
        try {
          void ch.send({
            type: "broadcast",
            event: "signal",
            payload: { from: selfId, to: null, kind: "bye" } satisfies SignalPayload,
          });
          void ch.untrack();
        } catch {
          /* noop */
        }
        void supabase.removeChannel(ch);
        channelRef.current = null;
      }
      closePeerConnection();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      peerIdRef.current = null;
    };
  }, [roomId, selfId, handleSignal, makeOffer, closePeerConnection, ensurePeerConnection]);

  // Keep presence name fresh without tearing down the call.
  useEffect(() => {
    firstNameRef.current = firstName;
    void channelRef.current?.track({ user_id: selfId, first_name: firstName } satisfies PresenceMeta);
  }, [firstName, selfId]);

  const toggleMic = useCallback(() => {
    const tracks = localStreamRef.current?.getAudioTracks() ?? [];
    if (tracks.length === 0) return;
    const next = !tracks[0]!.enabled;
    tracks.forEach((t) => {
      t.enabled = next;
    });
    setMicEnabled(next);
  }, []);

  return { status, micEnabled, toggleMic, peer, errorMessage, remoteAudioRef };
}
