// Manual context compaction: omp's `/compact <mode>` (cgscli: session/compact-modes.ts). The first mode is the quick one.
export const COMPACT_MODES = ["snapcompact", "soft", "remote", "handoff"] as const;
export type CompactMode = (typeof COMPACT_MODES)[number];

/** Quick compaction: no model call, history is archived onto images the model reads back. */
export const DEFAULT_COMPACT_MODE: CompactMode = "snapcompact";

export const parseCompactMode = (v: unknown): CompactMode => (COMPACT_MODES.find((m) => m === v) ?? DEFAULT_COMPACT_MODE);

/** The slash command that runs this mode. It takes no focus text: `snapcompact` refuses one. */
export const compactCommand = (mode: CompactMode): string => `/compact ${mode}`;

/**
 * What runs when a mode cannot: quick compaction archives history onto images, so a model that does not read images (or text the archive
 * font cannot draw) fails it; the local summary works on any model.
 */
export const compactFallback = (mode: CompactMode): CompactMode | undefined => (mode === "snapcompact" ? "soft" : undefined);

/** omp's report of a compaction that did not happen (`slash-commands/builtin-lifecycle.ts`). */
export const compactFailed = (output: string): boolean => /^Compaction failed\b/.test(output.trim());
