import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Bell, BellOff, BellRing, Copy, Mic, MicOff, Palette, UserRound, Video, VideoOff } from "lucide-react";

import { useWaveAudio } from "@/hooks/useWaveAudio";
import { useRoomPeer } from "@/hooks/useRoomPeer";
import { usePeerAlerts } from "@/hooks/usePeerAlerts";
import { STATUS_LABEL } from "@/lib/webrtc-config";
import { RoomChat } from "@/components/RoomChat";
import { Avatar } from "@/components/Avatar";
import { ProfileCard } from "@/components/ProfileCard";
import { VideoPanel } from "@/components/VideoPanel";

type Props = {
  roomId: string;
  code: string;
  selfId: string;
  firstName: string;
  nickname: string;
  avatarPath: string | null;
  status: string;
  onProfileChange: () => void;
  onLeave: () => void | Promise<void>;
};

const WALLPAPERS = [
  { id: "wp-default", label: "Wave" },
  { id: "wp-solid", label: "Plain" },
  { id: "wp-gradient", label: "Glow" },
  { id: "wp-dots", label: "Dots" },
  { id: "wp-waves", label: "Waves" },
  { id: "wp-grid", label: "Grid" },
] as const;
const WP_KEY = "wave-wallpaper";

export function RoomStage({ roomId, code, selfId, firstName, nickname, avatarPath, status: selfStatus, onProfileChange, onLeave }: Props) {
  // WebRTC audio engine — used as-is.
  const {
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
  } = useWaveAudio({ roomId, selfId, firstName });
  const { peer: profile, announce } = useRoomPeer(roomId, selfId, peer ? `${peer.firstName}` : null);
  const [leaving, setLeaving] = useState(false);
  const [typing, setTyping] = useState(false);
  const [wallpaper, setWallpaper] = useState<string>("wp-default");
  const [panel, setPanel] = useState<"none" | "wallpaper" | "profile">("none");
  const [remoteHidden, setRemoteHidden] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(WP_KEY);
    if (saved && WALLPAPERS.some((w) => w.id === saved)) setWallpaper(saved);
  }, []);

  const chooseWallpaper = (id: string) => {
    setWallpaper(id);
    localStorage.setItem(WP_KEY, id);
  };

  // "Online" = present in the room. Audio state is shown separately.
  const online = !!peer;
  const audioOk = status === "connected";
  const peerName = profile?.first_name || peer?.firstName || null;
  const subtitle = !peer ? "Waiting for your friend..." : typing ? "typing..." : profile?.status || "Online";

  const { permission, enableNotifications } = usePeerAlerts({ online, name: peerName });

  useEffect(() => {
    if (!remoteCameraOn) setRemoteHidden(false);
  }, [remoteCameraOn]);

  useEffect(() => {
    if (cameraError) toast.error(cameraError);
  }, [cameraError]);

  const showRemote = remoteCameraOn && !remoteHidden && !!remoteVideoStream;

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Room code copied");
    } catch {
      toast.error("Could not copy — the code is " + code);
    }
  };

  const handleLeave = async () => {
    setLeaving(true);
    await onLeave();
  };

  const toggle = (p: "wallpaper" | "profile") => setPanel((v) => (v === p ? "none" : p));

  return (
    <main className="mx-auto flex h-[100dvh] w-full min-w-0 max-w-md flex-col overflow-x-hidden">
      <header className="flex items-center gap-2 border-b border-border bg-card px-2 py-2">
        <button onClick={handleLeave} disabled={leaving} aria-label="Leave room" className="rounded-full p-2 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="relative">
          <Avatar path={profile?.avatar_url} name={peerName ?? "?"} size={40} />
          <span className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-card ${online ? "bg-success" : "bg-muted-foreground"}`} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-base font-semibold">{peerName ?? "WAVE"}</p>
          <p className={`truncate text-xs ${typing ? "text-primary" : online ? "text-success" : "text-muted-foreground"}`}>{subtitle}</p>
        </div>
        <button
          onClick={toggleMic}
          disabled={status === "mic-denied"}
          aria-label={micEnabled ? "Turn microphone off" : "Turn microphone on"}
          className={`relative flex h-10 w-10 items-center justify-center rounded-full transition-transform active:scale-90 disabled:opacity-50 ${
            micEnabled ? "wave-glow bg-primary text-primary-foreground" : "border border-border bg-secondary text-muted-foreground"
          }`}
        >
          {micEnabled && online && <span className="wave-ring absolute inset-0 rounded-full bg-primary/40" />}
          {micEnabled ? <Mic className="relative h-5 w-5" /> : <MicOff className="relative h-5 w-5" />}
        </button>
        <button
          onClick={toggleCamera}
          aria-label={cameraEnabled ? "Turn camera off" : "Turn camera on"}
          className={`flex h-10 w-10 items-center justify-center rounded-full transition-transform active:scale-90 ${
            cameraEnabled ? "bg-primary text-primary-foreground" : "border border-border bg-secondary text-muted-foreground"
          }`}
        >
          {cameraEnabled ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
        </button>
        <button onClick={() => toggle("wallpaper")} aria-label="Chat wallpaper" className="rounded-full p-2 text-muted-foreground hover:text-foreground">
          <Palette className="h-5 w-5" />
        </button>
        <button onClick={() => toggle("profile")} aria-label="My profile" className="rounded-full p-2 text-muted-foreground hover:text-foreground">
          <UserRound className="h-5 w-5" />
        </button>
      </header>

      <div className="flex items-center justify-between gap-2 border-b border-border bg-card/60 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {status === "mic-denied" ? "Microphone blocked" : micEnabled ? "Microphone on" : "Microphone muted"}
          {peer && status !== "mic-denied" && (
            <span className={`ml-2 ${audioOk ? "text-success" : status === "failed" || status === "error" ? "text-destructive" : "text-primary"}`}>
              · {STATUS_LABEL[status]}
            </span>
          )}
          {errorMessage && !audioOk && <span className="ml-2 text-destructive">{errorMessage}</span>}
        </span>
        {permission !== "unsupported" && (
          <button
            onClick={() => void enableNotifications()}
            aria-label="Online alerts"
            className={`shrink-0 rounded-full p-1 hover:text-foreground ${permission === "granted" ? "text-success" : ""}`}
          >
            {permission === "granted" ? <BellRing className="h-3.5 w-3.5" /> : permission === "denied" ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
          </button>
        )}
        <button onClick={copyCode} className="flex shrink-0 items-center gap-1 font-display tracking-[0.15em] hover:text-foreground">
          {code} <Copy className="h-3 w-3" />
        </button>
      </div>

      <VideoPanel
        remoteStream={showRemote ? remoteVideoStream : null}
        localStream={localVideoStream}
        mirrorLocal={cameraFacing === "user"}
        peerName={peerName}
        onFlip={flipCamera}
        onStopCamera={toggleCamera}
        onHideRemote={() => setRemoteHidden(true)}
      />

      {panel === "wallpaper" && (
        <div className="msg-in flex gap-2 overflow-x-auto border-b border-border bg-card px-3 py-2">
          {WALLPAPERS.map((w) => (
            <button
              key={w.id}
              onClick={() => chooseWallpaper(w.id)}
              className={`${w.id} flex h-14 w-14 shrink-0 items-end justify-center rounded-lg border-2 pb-1 text-[10px] ${
                wallpaper === w.id ? "border-primary" : "border-border"
              }`}
            >
              <span className="rounded bg-background/80 px-1">{w.label}</span>
            </button>
          ))}
        </div>
      )}
      {panel === "profile" && (
        <div className="msg-in border-b border-border bg-card px-3 py-2">
          <ProfileCard
            className=""
            userId={selfId}
            displayName={firstName}
            nickname={nickname}
            avatarPath={avatarPath}
            status={selfStatus}
            onChange={() => {
              onProfileChange();
              announce();
            }}
          />
        </div>
      )}

      <RoomChat
        roomId={roomId}
        selfId={selfId}
        selfName={firstName}
        peerName={peerName}
        peerAvatar={profile?.avatar_url ?? null}
        wallpaper={wallpaper}
        onTypingChange={setTyping}
      />

      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
    </main>
  );
}
