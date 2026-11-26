import type { ImageRef } from "../core/types";
import { byteTarget, keepOriginal, resizeSteps } from "./attachment-policy";

export const MAX_IMAGES = 5;
/**
 * omp's protocol v1 limits a frame to 1 MiB (the `ready` frame says so); a prompt also carries text. Base64 inflates by 4/3,
 * so a single image stays under this many base64 characters and several together share the same frame budget.
 */
export const FRAME_BUDGET_CHARS = 900_000;
/** Below this a picture is too degraded to be worth sending. */
export const MIN_IMAGE_CHARS = 60_000;

const toBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** mozjpeg (WASM), loaded on the first picture that needs re-encoding so the main bundle does not carry it (ADR 0036 section 9). */
type JpegEncoder = (data: ImageData, quality: number) => Promise<ArrayBuffer>;
let jpeg: Promise<JpegEncoder> | undefined;
function jpegEncoder(): Promise<JpegEncoder> {
  jpeg ??= (async (): Promise<JpegEncoder> => {
    const [{ default: encode, init }, { default: wasmUrl }] = await Promise.all([import("@jsquash/jpeg/encode"), import("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm?url")]);
    await init(await WebAssembly.compileStreaming(fetch(wasmUrl)));
    return (data, quality) => encode(data, { quality });
  })().catch((e) => {
    jpeg = undefined;
    throw e;
  });
  return jpeg;
}

/**
 * Reads a picture for sending. A picture that is already small enough goes as it is; the rest is scaled (sizes and qualities from
 * attachment-policy) and encoded with mozjpeg until it fits the byte target, which is the smaller of 500 KiB and this picture's
 * share of the frame (`budgetChars`). Rejects when the file is not an image, cannot be decoded, or cannot be made small enough.
 */
export async function prepareImage(file: File, budgetChars = FRAME_BUDGET_CHARS): Promise<ImageRef> {
  if (!file.type.startsWith("image/")) throw new Error("not an image");
  const target = byteTarget(budgetChars);
  const bitmap = await createImageBitmap(file);
  try {
    if (keepOriginal(bitmap.width, bitmap.height, file.type, file.size, target)) return { mimeType: file.type, data: await toBase64(file) };
    const encode = await jpegEncoder();
    for (const step of resizeSteps(bitmap.width, bitmap.height)) {
      const canvas = document.createElement("canvas");
      canvas.width = step.width;
      canvas.height = step.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("canvas");
      ctx.fillStyle = "#fff"; // JPEG has no alpha: transparent areas become white instead of black
      ctx.fillRect(0, 0, step.width, step.height);
      ctx.drawImage(bitmap, (step.width - step.drawWidth) / 2, (step.height - step.drawHeight) / 2, step.drawWidth, step.drawHeight);
      const pixels = ctx.getImageData(0, 0, step.width, step.height);
      for (const quality of step.qualities) {
        const bytes = await encode(pixels, quality);
        if (bytes.byteLength <= target) return { mimeType: "image/jpeg", data: await toBase64(new Blob([bytes], { type: "image/jpeg" })) };
      }
    }
    throw new Error("too large");
  } finally {
    bitmap.close();
  }
}

/** Images in a clipboard or drag payload. */
export const imageFiles = (items: DataTransfer | null): File[] => Array.from(items?.files ?? []).filter((f) => f.type.startsWith("image/"));
