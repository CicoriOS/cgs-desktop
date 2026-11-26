import { t } from "../i18n";

/** CGS-prefixed providers relay requests; other providers connect directly. */
export function providerKind(provider: string): "relay" | "direct" {
  return provider.startsWith("cgs-") ? "relay" : "direct";
}

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

/** 950, 12.3k, 4.56M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 2 : 1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

/** Cost in the units omp prices the model in (the site's currency for CGS channels): 4 decimals under 1, else 2. */
export function formatCost(c: number): string {
  return c < 1 ? c.toFixed(4) : c.toFixed(2);
}

export const formatPercent = (r: number): string => `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`;
