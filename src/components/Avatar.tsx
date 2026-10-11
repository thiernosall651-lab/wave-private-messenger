import { useEffect, useState } from "react";

import { avatarUrl } from "@/lib/avatar";

export function Avatar({ path, name, size = 32 }: { path: string | null | undefined; name: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setSrc(null);
    void avatarUrl(path).then((u) => active && setSrc(u));
    return () => {
      active = false;
    };
  }, [path]);
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary font-semibold text-muted-foreground"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {src ? <img src={src} alt={name} className="h-full w-full object-cover" /> : (name[0] ?? "?").toUpperCase()}
    </span>
  );
}
