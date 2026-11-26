/**
 * Sizing policy for pictures the web client sends (ADR 0036 §9), after omp's `resizeImage`
 * (packages/coding-agent/src/utils/image-resize.ts). Pure: it decides what goes out unchanged and, for the rest, the sizes and
 * JPEG qualities to try. Decoding, drawing and encoding stay with the caller.
 */

/** Longest side sent; larger pictures only cost tokens. */
const MAX_LONG_EDGE = 1568;
/** Shortest side sent. A picture below it is scaled up to it, or padded on that side when the long-edge cap stops the scale-up. */
const MIN_SHORT_EDGE = 200;
/** Byte cap per picture (ADR 0036 §9: about 500 KiB). */
const MAX_IMAGE_BYTES = 500 * 1024;
/** Formats that may go out unchanged. Any other format is always re-encoded. */
const KEEP_MIME: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/gif": true,
  "image/webp": true,
};
/** JPEG qualities tried at each size, in order: q75 (ADR 0036 §9), then omp's `qualitySteps`. */
const QUALITIES: readonly number[] = [75, 70, 60, 50, 40];
/** Factors of the target size, in order, as omp's `scaleSteps`. */
const SCALE_STEPS: readonly number[] = [1, 0.75, 0.5, 0.35, 0.25];

/** One size to try; see {@link resizeSteps}. */
export interface ResizeStep {
  /** Canvas size to encode. */
  width: number;
  height: number;
  /** Size the picture is drawn at, undistorted, centered on the canvas over white. Equal to the canvas unless padded. */
  drawWidth: number;
  drawHeight: number;
  /** JPEG qualities to try at this size, in order; the first that fits the byte target is sent. */
  qualities: readonly number[];
}

/**
 * Bytes one picture may take: 500 KiB, or the largest raw size whose base64 fits `budgetChars` (the picture's share of the
 * frame's base64 budget), whichever is smaller. Base64 spends 4 characters per started 3 bytes, so the share is
 * `3 * floor(budgetChars / 4)` bytes.
 */
export function byteTarget(budgetChars: number): number {
  return Math.min(MAX_IMAGE_BYTES, 3 * Math.floor(budgetChars / 4));
}

/**
 * Whether the original goes out unchanged: a PNG, JPEG, GIF or WebP whose long side is at most 1568 px, whose short side is at
 * least 200 px, and whose `bytes` are at most `targetBytes` (normally {@link byteTarget}). Otherwise it is re-encoded from
 * {@link resizeSteps}.
 */
export function keepOriginal(width: number, height: number, mime: string, bytes: number, targetBytes: number): boolean {
  return (
    KEEP_MIME[mime] === true &&
    Math.max(width, height) <= MAX_LONG_EDGE &&
    Math.min(width, height) >= MIN_SHORT_EDGE &&
    bytes <= targetBytes
  );
}

/**
 * Sizes to try, in order, for a `width`×`height` picture (both positive integers) that {@link keepOriginal} did not pass.
 *
 * The target keeps the aspect ratio. Its long side is capped at 1568 px. Its short side is raised to 200 px where the cap allows,
 * so a picture below the floor is scaled up as far as the cap permits and then padded if it still falls short. Each following step
 * scales the target by 0.75, 0.5, 0.35 and 0.25. A step's canvas is its drawn size with each side raised to 200 px, so no side
 * goes below 200 px, and the picture is centered on white. Steps whose canvas repeats the previous step's canvas are skipped.
 *
 * Every step lists the same qualities. The caller walks steps in order, and qualities in order at each, and sends the first try that
 * fits the byte target. Fill the canvas white before drawing: it is the backing for a translucent PNG re-encoded as JPEG (ADR 0036 §9).
 */
export function* resizeSteps(width: number, height: number): Generator<ResizeStep> {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  let scale = 1;
  if (long > MAX_LONG_EDGE) scale = MAX_LONG_EDGE / long;
  else if (short < MIN_SHORT_EDGE) scale = Math.min(MIN_SHORT_EDGE / short, MAX_LONG_EDGE / long);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  let prevWidth = 0;
  let prevHeight = 0;
  for (const factor of SCALE_STEPS) {
    const drawWidth = Math.max(1, Math.round(targetWidth * factor));
    const drawHeight = Math.max(1, Math.round(targetHeight * factor));
    const canvasWidth = Math.max(drawWidth, MIN_SHORT_EDGE);
    const canvasHeight = Math.max(drawHeight, MIN_SHORT_EDGE);
    // Both sides only shrink along the steps, so a repeated canvas is always the one just yielded.
    if (canvasWidth === prevWidth && canvasHeight === prevHeight) continue;
    prevWidth = canvasWidth;
    prevHeight = canvasHeight;
    yield { width: canvasWidth, height: canvasHeight, drawWidth, drawHeight, qualities: QUALITIES };
  }
}
