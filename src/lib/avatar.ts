import { supabase } from "@/integrations/supabase/client";

const cache = new Map<string, string>();

/** Avatars live in a private bucket; turn a stored path into a viewable signed URL. */
export async function avatarUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  const hit = cache.get(path);
  if (hit) return hit;
  const { data, error } = await supabase.storage.from("avatars").createSignedUrl(path, 60 * 60 * 24);
  if (error || !data) return null;
  cache.set(path, data.signedUrl);
  return data.signedUrl;
}

export async function uploadAvatar(userId: string, file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Please choose an image file.");
  if (file.size > 5 * 1024 * 1024) throw new Error("Image must be under 5 MB.");
  const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
  const path = `${userId}/avatar-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from("avatars").upload(path, file, { contentType: file.type });
  if (error) throw new Error("Upload failed. Check your connection and try again.");
  const { error: dbErr } = await supabase.from("profiles").update({ avatar_url: path }).eq("id", userId);
  if (dbErr) throw new Error("Could not save your photo.");
  return path;
}
