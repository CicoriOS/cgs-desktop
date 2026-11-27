// Manual context compaction: omp's `/compact <mode>` (cgscli: session/compact-modes.ts). The first mode is the quick one.
export const COMPACT_MODES = ["snapcompact", "soft", "remote", "handoff"] as const;
export type CompactMode = (typeof COMPACT_MODES)[number];

/** Quick compaction: no model call, history is archived onto images the model reads back. */
export const DEFAULT_COMPACT_MODE: CompactMode = "snapcompact";

export const parseCompactMode = (v: unknown): CompactMode => (COMPACT_MODES.find((m) => m === v) ?? DEFAULT_COMPACT_MODE);

/** The slash command that runs this mode. It takes no focus text: `snapcompact` refuses one. */
export const compactCommand = (mode: CompactMode): string => `/compact ${mode}`;
