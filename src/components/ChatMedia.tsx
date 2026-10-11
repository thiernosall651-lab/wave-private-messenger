import { useEffect, useRef, useState } from "react";
import { Pause, Play, X } from "lucide-react";

import { chatMediaUrl } from "@/lib/chat-media";

function useSignedUrl(path: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setUrl(null);
    setFailed(false);
    if (!path) return;
    void chatMediaUrl(path).then((u) => {
      if (!active) return;
      if (u) setUrl(u);
      else setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [path]);
  return { url, failed };
}

export function ImageMessage({ path, onOpen }: { path: string; onOpen: (url: string) => void }) {
  const { url, failed } = useSignedUrl(path);
  const [loaded, setLoaded] = useState(false);
  if (failed) return <p className="px-3 py-2 text-xs opacity-80">Photo unavailable</p>;
  return (
    <button onClick={() => url && onOpen(url)} className="block overflow-hidden rounded-xl" aria-label="View photo">
      {!loaded && <div className="h-48 w-56 animate-pulse bg-muted" />}
      {url && (
        <img
          src={url}
          alt="Shared photo"
          onLoad={() => setLoaded(true)}
          className={`max-h-72 w-full max-w-64 object-cover ${loaded ? "fade-img" : "hidden"}`}
        />
      )}
    </button>
  );
}

export function VideoMessage({ path }: { path: string }) {
  const { url, failed } = useSignedUrl(path);
  if (failed) return <p className="px-3 py-2 text-xs opacity-80">Video unavailable</p>;
  if (!url) return <div className="h-40 w-56 animate-pulse rounded-xl bg-muted" />;
  return <video src={url} controls playsInline preload="metadata" className="fade-img max-h-72 w-full max-w-64 rounded-xl bg-background" />;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function AudioMessage({ path, own }: { path: string; own: boolean }) {
  const { url, failed } = useSignedUrl(path);
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  if (failed) return <p className="px-3 py-2 text-xs opacity-80">Voice message unavailable</p>;
  const toggle = () => {
    const a = ref.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => setPlaying(false));
    else a.pause();
  };
  return (
    <div className="flex min-w-48 items-center gap-3 px-3 py-2">
      <button
        onClick={toggle}
        disabled={!url}
        aria-label={playing ? "Pause voice message" : "Play voice message"}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${own ? "bg-primary-foreground/20" : "bg-primary text-primary-foreground"} disabled:opacity-50`}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </button>
      <div className="flex h-6 flex-1 items-end gap-[3px]" aria-hidden>
        {Array.from({ length: 14 }).map((_, i) => (
          <span
            key={i}
            className={`w-[3px] rounded-full ${own ? "bg-primary-foreground/70" : "bg-primary/70"} ${playing ? "eq-bar" : ""}`}
            style={{ height: `${30 + ((i * 37) % 70)}%`, animationDelay: `${(i % 5) * 0.12}s` }}
          />
        ))}
      </div>
      <span className="text-[11px] tabular-nums opacity-80">{fmt(playing || time ? time : dur)}</span>
      {url && (
        <audio
          ref={ref}
          src={url}
          preload="metadata"
          onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setTime(0);
          }}
        />
      )}
    </div>
  );
}

export function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4" onClick={onClose} role="dialog" aria-label="Photo">
      <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 rounded-full bg-secondary p-2">
        <X className="h-5 w-5" />
      </button>
      <img src={url} alt="Shared photo" className="fade-img max-h-full max-w-full rounded-xl object-contain" />
    </div>
  );
}
