import { useEffect, useRef, useState } from "react";

import { avatarUrl, refreshAvatarUrl } from "@/lib/avatar";

export function Avatar({ path, name, size = 32 }: { path: string | null | undefined; name: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const currentPath = useRef(path);
  const retriedPath = useRef<string | null>(null);
  currentPath.current = path;

  useEffect(() => {
    let active = true;
    retriedPath.current = null;
    setSrc(null);
    void avatarUrl(path).then((url) => active && setSrc(url));
    return () => {
      active = false;
    };
  }, [path]);

  const retryFailedImage = () => {
    if (!path || retriedPath.current === path) {
      setSrc(null);
      return;
    }
    retriedPath.current = path;
    setSrc(null);
    void refreshAvatarUrl(path).then((url) => {
      if (currentPath.current === path) setSrc(url);
    });
  };

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary font-semibold text-muted-foreground"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {src ? <img key={src} src={src} alt={name} onError={retryFailedImage} className="h-full w-full object-cover" /> : (name[0] ?? "?").toUpperCase()}
    </span>
  );
}
