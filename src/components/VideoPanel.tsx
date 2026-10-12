import { useEffect, useRef } from "react";
import { SwitchCamera, X } from "lucide-react";

type Props = {
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
  mirrorLocal: boolean;
  peerName: string | null;
  onFlip: () => void;
  onStopCamera: () => void;
  onHideRemote: () => void;
};

function useAttachedStream(stream: MediaStream | null) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => {});
    return () => {
      if (el.srcObject === stream) el.srcObject = null;
    };
  }, [stream]);
  return ref;
}

/** Remote video (large) + own preview (picture-in-picture). Shown only while a camera is on. */
export function VideoPanel({ remoteStream, localStream, mirrorLocal, peerName, onFlip, onStopCamera, onHideRemote }: Props) {
  const remoteRef = useAttachedStream(remoteStream);
  const localRef = useAttachedStream(localStream);
  const hasRemote = !!remoteStream;
  const hasLocal = !!localStream;
  if (!hasRemote && !hasLocal) return null;

  return (
    <div className="msg-in relative border-b border-border bg-black">
      <div className="relative mx-auto aspect-[4/3] max-h-[36dvh] w-full">
        {hasRemote ? (
          <video ref={remoteRef} autoPlay playsInline muted className="h-full w-full object-cover" />
        ) : (
          <video
            ref={localRef}
            autoPlay
            playsInline
            muted
            className={`h-full w-full object-cover ${mirrorLocal ? "-scale-x-100" : ""}`}
          />
        )}

        {hasRemote && (
          <span className="absolute left-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] text-white">
            {peerName ?? "Friend"}
          </span>
        )}

        {hasRemote && hasLocal && (
          <video
            ref={localRef}
            autoPlay
            playsInline
            muted
            className={`absolute bottom-2 right-2 h-28 w-20 rounded-lg border border-white/30 object-cover shadow-lg ${
              mirrorLocal ? "-scale-x-100" : ""
            }`}
          />
        )}

        <div className="absolute right-2 top-2 flex gap-1.5">
          {hasLocal && (
            <button
              onClick={onFlip}
              aria-label="Switch camera"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white active:scale-90"
            >
              <SwitchCamera className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={hasLocal && !hasRemote ? onStopCamera : onHideRemote}
            aria-label={hasLocal && !hasRemote ? "Turn camera off" : "Hide video"}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white active:scale-90"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
