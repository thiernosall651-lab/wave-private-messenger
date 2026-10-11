import { supabase } from "@/integrations/supabase/client";

export type MediaKind = "image" | "video" | "audio";

export const MEDIA_LIMITS: Record<MediaKind, number> = {
  image: 10 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  audio: 5 * 1024 * 1024,
};
export const MAX_VOICE_SECONDS = 60;

const cache = new Map<string, { url: string; expiresAt: number }>();
const RESUMABLE_THRESHOLD = 6 * 1024 * 1024;
const RESUMABLE_CHUNK_SIZE = 6 * 1024 * 1024;

/** Chat media is in a private bucket; only room members can create signed URLs. */
export async function chatMediaUrl(path: string, expiresInSeconds = 60 * 60, bucket = "chat-media"): Promise<string | null> {
  const cacheKey = bucket + ":" + path;
  const hit = expiresInSeconds === 60 * 60 ? cache.get(cacheKey) : undefined;
  if (hit && hit.expiresAt > Date.now() + 30_000) return hit.url;
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
  if (error || !data) return null;
  if (expiresInSeconds === 60 * 60) cache.set(cacheKey, { url: data.signedUrl, expiresAt: Date.now() + expiresInSeconds * 1000 });
  return data.signedUrl;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function encodeMetadata(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

/** TUS upload in 6 MB chunks so large videos can recover from temporary network drops. */
async function uploadResumable(path: string, file: Blob, onProgress?: (percent: number) => void, bucket = "chat-media") {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const session = sessionData.session;
  if (sessionError || !session?.access_token) throw new Error("Sign in again before uploading this file.");
  const env = import.meta.env;
  const supabaseUrl = env["VITE_SUPABASE_URL"] as string | undefined;
  const publicKey = env["VITE_SUPABASE_PUBLISHABLE_KEY"] as string | undefined;
  if (!supabaseUrl || !publicKey) throw new Error("Storage configuration is missing.");
  const projectRef = (env["VITE_SUPABASE_PROJECT_ID"] as string | undefined) || new URL(supabaseUrl).hostname.split(".")[0];
  const endpoint = "https://" + projectRef + ".storage.supabase.co/storage/v1/upload/resumable";
  const authHeaders = { authorization: "Bearer " + session.access_token, apikey: publicKey };
  const metadata = Object.entries({ bucketName: bucket, objectName: path, contentType: file.type || "application/octet-stream", cacheControl: "3600" })
    .map(([key, value]) => key + " " + encodeMetadata(value)).join(",");
  const create = await fetch(endpoint, { method: "POST", headers: { ...authHeaders, "Tus-Resumable": "1.0.0", "Upload-Length": String(file.size), "Upload-Metadata": metadata, "x-upsert": "false" } });
  if (!create.ok) {
    if (create.status === 413 || create.status === 400) throw new Error("Storage rejected this file. Check your Supabase global upload limit; Free plans may be limited to 50 MB.");
    throw new Error("Could not start resumable upload (HTTP " + create.status + ").");
  }
  const location = create.headers.get("Location");
  if (!location) throw new Error("Storage did not return a resumable upload URL.");
  const uploadUrl = new URL(location, endpoint).href;
  let offset = 0;
  onProgress?.(0);
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(offset + RESUMABLE_CHUNK_SIZE, file.size));
    let completed = false;
    for (let attempt = 0; attempt < 5 && !completed; attempt++) {
      try {
        const response = await fetch(uploadUrl, { method: "PATCH", headers: { ...authHeaders, "Tus-Resumable": "1.0.0", "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" }, body: chunk });
        if (response.ok) {
          const nextOffset = Number(response.headers.get("Upload-Offset"));
          offset = Number.isFinite(nextOffset) && nextOffset > offset ? nextOffset : Math.min(file.size, offset + chunk.size);
          completed = true;
          onProgress?.(Math.min(100, Math.floor(offset / file.size * 100)));
          continue;
        }
        if (response.status < 500 && response.status !== 409) {
          if (response.status === 413 || response.status === 400) throw new Error("Storage rejected this file. Check your Supabase global upload limit; Free plans may be limited to 50 MB.");
          throw new Error("Upload stopped (HTTP " + response.status + ").");
        }
      } catch (error) {
        if (error instanceof Error && (error.message.includes("Storage rejected") || error.message.includes("Upload stopped"))) throw error;
      }
      try {
        const head = await fetch(uploadUrl, { method: "HEAD", headers: { ...authHeaders, "Tus-Resumable": "1.0.0" } });
        const recovered = Number(head.headers.get("Upload-Offset"));
        if (head.ok && Number.isFinite(recovered) && recovered >= 0 && recovered <= file.size) {
          if (recovered > offset) {
            offset = recovered;
            onProgress?.(Math.min(100, Math.floor(offset / file.size * 100)));
          }
          if (offset >= file.size) completed = true;
        }
      } catch { /* Continue with bounded retry backoff. */ }
      if (!completed && attempt < 4) await wait(800 * (attempt + 1));
    }
    if (!completed && offset < file.size) throw new Error("Upload interrupted. Check your connection and try again.");
  }
  onProgress?.(100);
}

export function validateMedia(kind: MediaKind, file: Blob): string | null {
  const prefix = kind === "image" ? "image/" : kind === "video" ? "video/" : "audio/";
  if (file.type && !file.type.startsWith(prefix)) return `Please choose a ${kind === "image" ? "photo" : kind} file.`;
  if (file.size > MEDIA_LIMITS[kind]) return `File is too large (max ${MEDIA_LIMITS[kind] / 1024 / 1024} MB).`;
  return null;
}

export async function uploadChatMedia(roomId: string, userId: string, kind: MediaKind, file: Blob, onProgress?: (percent: number) => void, viewOnce = false): Promise<string> {
  const err = validateMedia(kind, file);
  if (err) throw new Error(err);
  const fromName = file instanceof File ? file.name.split(".").pop()?.toLowerCase() : undefined;
  const fromType = file.type.split("/")[1]?.split(";")[0];
  const ext = (fromName || fromType || "bin").replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
  const path = `${roomId}/${userId}/${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const bucket = viewOnce ? "chat-view-once" : "chat-media";
  try {
    if (file.size > RESUMABLE_THRESHOLD) {
      await uploadResumable(path, file, onProgress, bucket);
    } else {
      const { error } = await supabase.storage.from(bucket).upload(path, file, file.type ? { contentType: file.type } : {});
      if (error) throw new Error(error.message);
      onProgress?.(100);
    }
    return path;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Upload failed. Check your connection and try again.");
  }
}
