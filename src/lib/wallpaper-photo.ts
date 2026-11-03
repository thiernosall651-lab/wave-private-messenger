/** Réduit une photo choisie (max 1080 px, JPEG) pour l'utiliser comme fond d'écran, stockée sur l'appareil. */
export const WALLPAPER_PHOTO_KEY = "wave-wallpaper-photo";

export async function fileToWallpaperDataUrl(file: File, maxSide = 1080, quality = 0.72): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", quality);
}
