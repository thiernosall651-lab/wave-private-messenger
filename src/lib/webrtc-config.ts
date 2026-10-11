/**
 * Central WebRTC transport configuration.
 *
 * MVP uses public STUN servers only. To add a TURN server later, push an
 * extra entry into `iceServers` here — no other part of the WebRTC layer
 * needs to change.
 */
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    // TURN (add later, e.g.):
    // { urls: "turn:turn.example.com:3478", username: "...", credential: "..." },
  ],
  iceCandidatePoolSize: 2,
};

export type ConnectionStatus =
  | "idle"
  | "requesting-mic"
  | "mic-denied"
  | "waiting"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "disconnected"
  | "error";

export const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: "Connecting...",
  "requesting-mic": "Requesting microphone...",
  "mic-denied": "Microphone permission denied",
  waiting: "Waiting for the other user",
  connecting: "Connecting audio...",
  connected: "Audio connected",
  reconnecting: "Reconnecting audio...",
  failed: "Audio connection failed",
  disconnected: "Reconnecting audio...",
  error: "Audio connection failed",
};
