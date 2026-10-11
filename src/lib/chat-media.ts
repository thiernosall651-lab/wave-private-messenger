import { supabase } from "@/integrations/supabase/client";

export type MediaKind = "image" | "video" | "audio";

export const MEDIA_LIMITS: Record<MediaKind, number> = {
  image: 10 * 1024 * 1024,
  video: 25 * 1024 * 1024,
  audio: 5 * 1024 * 1024,
};
export const MAX_VOICE_SECONDS = 60;

const cache = new Map<string, string>();

/** Chat media is in a private bucket; only room members can create signed URLs. */
export async function chatMediaUrl(path: string): Promise<string | null> {
  const hit = cache.get(path);
  if (hit) return hit;
  const { data, error } = await supabase.storage.from("chat-media").createSignedUrl(path, 60 * 60);
  if (error || !data) return null;
  cache.set(path, data.signedUrl);
  return data.signedUrl;
}

export function validateMedia(kind: MediaKind, file: Blob): string | null {
  const prefix = kind === "image" ? "image/" : kind === "video" ? "video/" : "audio/";
  if (file.type && !file.type.startsWith(prefix)) return `Please choose a ${kind === "image" ? "photo" : kind} file.`;
  if (file.size > MEDIA_LIMITS[kind]) return `File is too large (max ${MEDIA_LIMITS[kind] / 1024 / 1024} MB).`;
  return null;
}

export async function uploadChatMedia(roomId: string, userId: string, kind: MediaKind, file: Blob): Promise<string> {
  const err = validateMedia(kind, file);
  if (err) throw new Error(err);
  const fromName = file instanceof File ? file.name.split(".").pop()?.toLowerCase() : undefined;
  const fromType = file.type.split("/")[1]?.split(";")[0];
  const ext = (fromName || fromType || "bin").replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
  const path = `${roomId}/${userId}/${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage
    .from("chat-media")
    .upload(path, file, file.type ? { contentType: file.type } : {});
  if (error) throw new Error("Upload failed. Check your connection and try again.");
  return path;
}
