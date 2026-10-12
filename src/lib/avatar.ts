import { supabase } from "@/integrations/supabase/client";

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24;
const CACHE_REFRESH_MARGIN_MS = 60_000;
const cache = new Map<string, { url: string; expiresAt: number }>();

/** Avatars live in a private bucket; refresh signed URLs before they expire. */
export async function avatarUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;

  const hit = cache.get(path);
  if (hit && hit.expiresAt > Date.now() + CACHE_REFRESH_MARGIN_MS) return hit.url;
  cache.delete(path);

  const { data, error } = await supabase.storage
    .from("avatars")
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error || !data) return null;

  cache.set(path, {
    url: data.signedUrl,
    expiresAt: Date.now() + SIGNED_URL_TTL_SECONDS * 1000 - CACHE_REFRESH_MARGIN_MS,
  });
  return data.signedUrl;
}

/** Recreate a signed URL if the browser reports that its current avatar URL failed. */
export async function refreshAvatarUrl(path: string): Promise<string | null> {
  cache.delete(path);
  return avatarUrl(path);
}

export async function uploadAvatar(userId: string, file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Please choose an image file.");
  if (file.size > 5 * 1024 * 1024) throw new Error("Image must be under 5 MB.");
  const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
  const path = `${userId}/avatar-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from("avatars").upload(path, file, { contentType: file.type });
  if (error) throw new Error("Upload failed. Check your connection and try again.");

  // An UPDATE filtered by RLS can affect zero rows without returning a database error.
  // Select the updated row so the UI never reports success unless the path was saved.
  const { data: savedProfile, error: dbErr } = await supabase
    .from("profiles")
    .update({ avatar_url: path })
    .eq("id", userId)
    .select("id, avatar_url")
    .maybeSingle();

  if (dbErr || !savedProfile?.avatar_url) {
    // Remove the newly uploaded object if the profile row could not be updated.
    await supabase.storage.from("avatars").remove([path]);
    throw new Error("Could not save your photo. Refresh the page and try again.");
  }
  return path;
}
