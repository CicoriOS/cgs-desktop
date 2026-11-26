import type { CSSProperties } from "react";
import type { RingState, ThinkingLevel } from "../core/types";
import { type MessageKey, t, useT } from "../i18n";

// Status ring semantics: cgs-client-docs/adr/0030-status-ring.md.
const BLUE_FROM = [0x7f, 0xe0, 0xe8];
const BLUE_TO = [0x1d, 0x4e, 0xd8];
const LEVEL_T: Partial<Record<string, number>> = { auto: 0, minimal: 0.2, low: 0.4, medium: 0.7, high: 1 };
const ORANGE = "#ff8c1a";
const GREY = "#8a8a8a";

const LEVEL_KEYS: Record<string, MessageKey> = {
  off: "level.off", auto: "level.auto", minimal: "level.minimal", low: "level.low", medium: "level.medium", high: "level.high", xhigh: "level.xhigh", max: "level.max",
};
const RING_KEYS: Record<Exclude<RingState, "think">, MessageKey> = { idle: "ring.idle", work: "ring.work", ok: "ring.ok", fail: "ring.fail", stop: "ring.stop" };

export const levelName = (l: string) => (LEVEL_KEYS[l] ? t(LEVEL_KEYS[l]) : l);
/** `xhigh` and `max` breathe fast and turn orange. */
export const isHot = (level: string) => level === "xhigh" || level === "max";

/** `off` is grey (thinking is not used), `auto` is the aqua end of the scale, then deeper blue with effort, orange when hot. */
export function levelColor(level: string): string {
  if (level === "off") return GREY;
  if (isHot(level)) return ORANGE;
  const t = LEVEL_T[level] ?? 0;
  return `rgb(${BLUE_FROM.map((a, i) => Math.round(a + (BLUE_TO[i]! - a) * t)).join(",")})`;
}

export function ringName(state: RingState, level: string): string {
  return state === "think" ? t("ring.think", { level: levelName(level) }) : t(RING_KEYS[state]);
}

export function Ring({ state, level, small }: { state: RingState; level: ThinkingLevel | string; small?: boolean }) {
  useT();
  const name = ringName(state, level);
  const style: CSSProperties & Record<string, string> = { "--dur": state === "think" && isHot(level) ? "1.1s" : "2.4s" };
  if (state === "think") style["--c"] = levelColor(level);
  return <span className={small ? "ring sm" : "ring"} role="img" data-s={state} aria-label={name} title={name} style={style} />;
}
