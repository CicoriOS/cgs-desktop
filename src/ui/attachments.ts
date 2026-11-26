import type { ImageRef } from "../core/types";

export const MAX_IMAGES = 5;
/** Longest side sent to the model; larger pictures only cost tokens. */
const MAX_SIDE_PX = 1568;
/**
 * omp's protocol v1 limits a frame to 1 MiB (the `ready` frame says so); a prompt also carries text. Base64 inflates by 4/3,
 * so a single image stays under this many base64 characters and several together share the same frame budget.
 */
export const FRAME_BUDGET_CHARS = 900_000;
/** Below this a picture is too degraded to be worth sending. */
export const MIN_IMAGE_CHARS = 60_000;

const KEEP_AS_IS = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const toBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), type, quality));

/**
 * Reads a picture for sending. Small ones go as they are; big ones are scaled down and re-encoded as JPEG until their base64 fits
 * `budgetChars` (a share of the frame limit). Rejects when the file is not an image or cannot be decoded.
 */
export async function prepareImage(file: File, budgetChars = FRAME_BUDGET_CHARS): Promise<ImageRef> {
  if (!file.type.startsWith("image/")) throw new Error("not an image");
  const bitmap = await createImageBitmap(file);
  try {
    const fits = bitmap.width <= MAX_SIDE_PX && bitmap.height <= MAX_SIDE_PX;
    if (fits && KEEP_AS_IS.has(file.type) && file.size * (4 / 3) <= budgetChars) return { mimeType: file.type, data: await toBase64(file) };

    let scale = Math.min(1, MAX_SIDE_PX / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 8; attempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas");
      ctx.fillStyle = "#fff"; // JPEG has no alpha: transparent areas become white instead of black
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.9, 0.78, 0.66, 0.52]) {
        const blob = await toBlob(canvas, "image/jpeg", quality);
        if (blob.size * (4 / 3) <= budgetChars) return { mimeType: "image/jpeg", data: await toBase64(blob) };
      }
      scale *= 0.75;
    }
    throw new Error("too large");
  } finally {
    bitmap.close();
  }
}

/** Images in a clipboard or drag payload. */
export const imageFiles = (items: DataTransfer | null): File[] => Array.from(items?.files ?? []).filter((f) => f.type.startsWith("image/"));
