import { t } from "../i18n";

/** "just now", "5 min", "3 h", "2 d", "1 mo" (or the Chinese forms). */
export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return t("time.now");
  if (s < 3600) return t("time.min", { n: Math.floor(s / 60) });
  if (s < 86400) return t("time.hour", { n: Math.floor(s / 3600) });
  if (s < 86400 * 30) return t("time.day", { n: Math.floor(s / 86400) });
  return t("time.month", { n: Math.floor(s / 86400 / 30) });
}

export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? t("dur.sec", { n: s }) : t("dur.min", { m: Math.floor(s / 60), s: s % 60 });
}

export const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
