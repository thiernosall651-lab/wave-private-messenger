import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Avatar } from "@/components/Avatar";
import { uploadAvatar } from "@/lib/avatar";
import { supabase } from "@/integrations/supabase/client";

type Props = {
  userId: string;
  displayName: string;
  avatarPath: string | null;
  nickname: string;
  status?: string;
  onChange: () => void;
  className?: string;
};

export function ProfileCard({ userId, displayName, avatarPath, nickname, status = "", onChange, className = "mt-6" }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(nickname);
  const [stat, setStat] = useState(status);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setName(nickname), [nickname]);
  useEffect(() => setStat(status), [status]);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await uploadAvatar(userId, file);
      toast.success("Photo updated");
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const removePhoto = async () => {
    setUploading(true);
    setError(null);
    const { error: e } = await supabase.from("profiles").update({ avatar_url: null }).eq("id", userId);
    if (!e && avatarPath) await supabase.storage.from("avatars").remove([avatarPath]);
    setUploading(false);
    if (e) setError("Could not remove photo");
    else {
      toast.success("Photo removed");
      onChange();
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const { error: err } = await supabase
      .from("profiles")
      .update({ nickname: name.trim().slice(0, 40) || null, status: stat.trim().slice(0, 80) || null })
      .eq("id", userId);
    setSaving(false);
    if (err) setError("Could not save your profile. Check your connection.");
    else {
      toast.success("Profile saved");
      onChange();
    }
  };

  const input = "h-10 min-w-0 rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary";
  return (
    <section className={`wave-panel flex gap-4 p-4 ${className}`}>
      <div className="flex flex-col items-center gap-1">
        <button onClick={() => fileRef.current?.click()} disabled={uploading} aria-label="Change profile photo" className="relative">
          <Avatar path={avatarPath} name={displayName} size={56} />
          <span className="absolute -bottom-1 -right-1 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
            {uploading ? "…" : "✎"}
          </span>
        </button>
        {avatarPath && (
          <button onClick={() => void removePhoto()} disabled={uploading} className="text-[10px] text-muted-foreground hover:text-destructive">
            Remove
          </button>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
      <form onSubmit={save} className="flex flex-1 flex-col gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Nickname (optional)" aria-label="Nickname" className={input} />
        <input value={stat} onChange={(e) => setStat(e.target.value)} maxLength={80} placeholder="Short status (optional)" aria-label="Status" className={input} />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-destructive">{error ?? ""}</span>
          <button disabled={saving} className="h-9 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </section>
  );
}
