import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { RTC_CONFIG, loadIceServers, type ConnectionStatus } from "@/lib/webrtc-config";

type SignalPayload = {
  from: string;
  to: string | null;
  kind: "offer" | "answer" | "ice" | "bye" | "restart" | "camera";
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  on?: boolean;
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
const VIDEO_MAX_BITRATE = 800_000;

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
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<"user" | "environment">("user");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [localVideoStream, setLocalVideoStream] = useState<MediaStream | null>(null);
  const [remoteVideoStream, setRemoteVideoStream] = useState<MediaStream | null>(null);
  const [remoteCameraOn, setRemoteCameraOn] = useState(false);

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
  // Video is optional and fully separate from the audio stream: the video
  // transceiver is negotiated once with the call, then the camera is switched
  // on/off with replaceTrack (no renegotiation, audio never interrupted).
  const localVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const sendCameraStateRef = useRef<() => void>(() => {});

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
    videoSenderRef.current = null;
    setRemoteVideoStream(null);
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
  }, []);

  const applyVideoTrack = useCallback(async (track: MediaStreamTrack | null) => {
    const sender = videoSenderRef.current;
    if (!sender) return;
    try {
      await sender.replaceTrack(track);
      if (track) {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        params.encodings[0]!.maxBitrate = VIDEO_MAX_BITRATE;
        await sender.setParameters(params);
      }
    } catch {
      /* video is optional: audio must keep working */
    }
  }, []);

  const bindVideoSender = useCallback(
    (pc: RTCPeerConnection) => {
      const transceiver = pc.getTransceivers().find((t) => t.receiver.track.kind === "video");
      if (!transceiver) {
        videoSenderRef.current = null;
        return;
      }
      try {
        if (transceiver.direction !== "sendrecv") transceiver.direction = "sendrecv";
      } catch {
        /* noop */
      }
      videoSenderRef.current = transceiver.sender;
      if (localVideoTrackRef.current) void applyVideoTrack(localVideoTrackRef.current);
    },
    [applyVideoTrack],
  );

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

      // The offerer reserves a send/receive video slot. The answerer adopts it
      // from the offer (see handleSignal), so both sides can use the camera.
      if (selfId < remoteId) {
        try {
          pc.addTransceiver("video", { direction: "sendrecv" });
        } catch {
          /* video unsupported: audio-only still works */
        }
        bindVideoSender(pc);
      }

      pc.onicecandidate = (event) => {
        if (pcRef.current !== pc) return;
        if (event.candidate) {
          send({ from: selfId, to: remoteId, kind: "ice", candidate: event.candidate.toJSON() });
        }
      };

      pc.ontrack = (event) => {
        if (pcRef.current !== pc) return;
        if (event.track.kind === "video") {
          setRemoteVideoStream(new MediaStream([event.track]));
          return;
        }

        // Some browsers emit an audio track without event.streams. Attach the
        // track explicitly so the remote audio still reaches the audio element.
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        const audio = remoteAudioRef.current;
        if (!audio) return;
        if (audio.srcObject !== stream) audio.srcObject = stream;

        const tryPlay = () => {
          if (audio.srcObject === stream) void audio.play().catch(() => {
            // Retry from the microphone button's user gesture if autoplay is blocked.
          });
        };
        event.track.onunmute = tryPlay;
        tryPlay();
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
            sendCameraStateRef.current();
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
    [selfId, send, bindVideoSender],
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

  sendCameraStateRef.current = () => {
    const remote = peerIdRef.current;
    if (!remote || teardownRef.current) return;
    send({ from: selfId, to: remote, kind: "camera", on: !!localVideoTrackRef.current });
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
        setRemoteCameraOn(false);
        setStatus("waiting");
        return;
      }

      if (payload.kind === "camera") {
        setRemoteCameraOn(!!payload.on);
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
          bindVideoSender(pc);
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
    [closePeerConnection, ensurePeerConnection, bindVideoSender, flushIce, selfId, send],
  );

  useEffect(() => {
    teardownRef.current = false;
    let cancelled = false;
    let subscribedOnce = false;
    let signalingRetry: ReturnType<typeof setTimeout> | null = null;
    let signalingRetryAttempt = 0;

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

      const connectSignaling = () => {
        if (cancelled) return;
        const channel = supabase.channel(`wave-room:${roomId}`, {
          config: {
            presence: { key: selfId },
            broadcast: { self: false, ack: false },
          },
        });
        channelRef.current = channel;

        const scheduleReconnect = () => {
          if (cancelled || channelRef.current !== channel || signalingRetry) return;
          setErrorMessage("Lost connection to the signaling service. Reconnecting...");
          const delay = Math.min(15000, 1500 * 2 ** signalingRetryAttempt);
          signalingRetryAttempt = Math.min(signalingRetryAttempt + 1, 4);
          signalingRetry = setTimeout(() => {
            signalingRetry = null;
            if (cancelled || channelRef.current !== channel) return;
            channelRef.current = null;
            void supabase.removeChannel(channel).finally(() => {
              if (!cancelled) connectSignaling();
            });
          }, delay);
        };

        channel.on("broadcast", { event: "signal" }, ({ payload }) => {
          if (cancelled || channelRef.current !== channel) return;
          void handleSignal(payload as SignalPayload);
        });

        channel.on("presence", { event: "sync" }, () => {
          if (cancelled || channelRef.current !== channel) return;
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
            setRemoteCameraOn(false);
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

        channel.subscribe(async (state, err) => {
          if (cancelled || channelRef.current !== channel) return;
          if (state === "SUBSCRIBED") {
            if (signalingRetry) {
              clearTimeout(signalingRetry);
              signalingRetry = null;
            }
            signalingRetryAttempt = 0;
            const trackStatus = await channel.track({
              user_id: selfId,
              first_name: firstNameRef.current,
            } satisfies PresenceMeta);
            if (trackStatus !== "ok") {
              console.error("[WAVE signaling] Presence track failed:", trackStatus);
              scheduleReconnect();
              return;
            }
            setErrorMessage(null);
            // Signaling came back after a drop: re-check audio, rebuild if not connected.
            if (subscribedOnce && peerIdRef.current && pcRef.current?.connectionState !== "connected") {
              lastRecoverRef.current = 0;
              recoverRef.current();
            }
            subscribedOnce = true;
          } else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") {
            console.error("[WAVE signaling] Subscription state:", state, err?.message ?? err ?? "No error details");
            setErrorMessage(`Lost connection to signaling (${state}). Reconnecting...`);
            scheduleReconnect();
          }
        });
      };

      connectSignaling();
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
          const s = r as { type: string; kind?: string; mediaType?: string; bytesReceived?: number; state?: string };
          if (s.type === "inbound-rtp" && (s.kind ?? s.mediaType) === "audio") bytes += s.bytesReceived ?? 0;
          // Also count traffic on the working network path (it includes RTCP). A friend who
          // muted their microphone may send almost no audio packets, but the path itself keeps
          // carrying data — so a muted friend must never look like a dead connection.
          if (s.type === "candidate-pair" && s.state === "succeeded") bytes += s.bytesReceived ?? 0;
        });
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
      if (signalingRetry) {
        clearTimeout(signalingRetry);
        signalingRetry = null;
      }
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
      localVideoTrackRef.current?.stop();
      localVideoTrackRef.current = null;
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

    // Tapping this control is a user gesture, which can unlock audio playback
    // on browsers that reject autoplay during call setup.
    const remoteAudio = remoteAudioRef.current;
    if (remoteAudio?.srcObject) void remoteAudio.play().catch(() => {});
  }, []);

  const stopCamera = useCallback(() => {
    const track = localVideoTrackRef.current;
    localVideoTrackRef.current = null;
    if (track) {
      track.onended = null;
      track.stop();
    }
    setLocalVideoStream(null);
    setCameraEnabled(false);
    void applyVideoTrack(null);
    sendCameraStateRef.current();
  }, [applyVideoTrack]);

  const startCamera = useCallback(
    async (facing: "user" | "environment") => {
      setCameraError(null);
      // Release the previous camera first: many phones cannot open two at once.
      const previous = localVideoTrackRef.current;
      if (previous) {
        previous.onended = null;
        previous.stop();
        localVideoTrackRef.current = null;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 24, max: 30 },
          },
        });
      } catch {
        setLocalVideoStream(null);
        setCameraEnabled(false);
        void applyVideoTrack(null);
        sendCameraStateRef.current();
        setCameraError("Camera access was blocked, or no camera was found.");
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track || teardownRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      localVideoTrackRef.current = track;
      track.onended = () => {
        if (localVideoTrackRef.current === track) stopCamera();
      };
      setLocalVideoStream(new MediaStream([track]));
      setCameraFacing(facing);
      setCameraEnabled(true);
      await applyVideoTrack(track);
      sendCameraStateRef.current();
    },
    [applyVideoTrack, stopCamera],
  );

  const toggleCamera = useCallback(() => {
    if (localVideoTrackRef.current) stopCamera();
    else void startCamera(cameraFacing);
  }, [cameraFacing, startCamera, stopCamera]);

  const flipCamera = useCallback(() => {
    if (!localVideoTrackRef.current) return;
    void startCamera(cameraFacing === "user" ? "environment" : "user");
  }, [cameraFacing, startCamera]);

  return {
    status,
    micEnabled,
    toggleMic,
    peer,
    errorMessage,
    remoteAudioRef,
    cameraEnabled,
    cameraFacing,
    cameraError,
    toggleCamera,
    flipCamera,
    localVideoStream,
    remoteVideoStream,
    remoteCameraOn,
  };
}
