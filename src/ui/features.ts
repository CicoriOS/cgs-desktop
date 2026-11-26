/**
 * Pieces the web build keeps hidden. The code stays: the desktop profile switches them on (ADR 0032 and the client profiles doc).
 * - attachButton: the "+" in the message box (file picker, desktop only; the web build attaches images by paste and drop).
 * - rightPanel: the right sidebar for the file viewer and Git changes (needs local file access).
 */
export const FEATURES = {
  attachButton: false,
  rightPanel: false,
} as const;
