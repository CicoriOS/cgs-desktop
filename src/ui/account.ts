import type { AccountSnapshot, AccountTier, Subscription } from "../core/types";
import { t } from "../i18n";

const TIER_NAMES: Record<Exclude<AccountTier, "dedicated">, string> = { free: "Free", go: "Go", pro: "Pro" };

export const tierName = (tier: AccountTier): string => (tier === "dedicated" ? t("acct.dedicated") : TIER_NAMES[tier] ?? "");

/** The share of a plan used, 0 to 100; an unlimited plan has none. */
export const usedPercent = (sub: Subscription): number => (sub.unlimited || sub.amountTotal <= 0 ? 0 : Math.min(100, Math.max(0, (sub.amountUsed / sub.amountTotal) * 100)));

export const percentText = (percent: number): string => (percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`);

export type Tone = "ok" | "warn" | "high";
export const toneOf = (percent: number): Tone => (percent >= 80 ? "high" : percent >= 50 ? "warn" : "ok");

/** "5 min", "3 h", "12 d" until a unix-seconds instant. */
function untilText(seconds: number, now: number): string {
  const minutes = Math.round((seconds * 1000 - now) / 60_000);
  if (minutes < 60) return t("time.min", { n: Math.max(1, minutes) });
  const hours = Math.round(minutes / 60);
  return hours < 48 ? t("time.hour", { n: hours }) : t("time.day", { n: Math.round(hours / 24) });
}

const pad = (n: number) => String(n).padStart(2, "0");
const dateText = (seconds: number): string => {
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** When the plan renews or ends; empty for a plan that neither resets nor expires. */
export function planTimeText(sub: Subscription, now: number): string {
  if (sub.resetPeriod !== "never" && sub.nextResetAt > 0) return t("acct.resetsIn", { when: untilText(sub.nextResetAt, now) });
  if (sub.endTime > 0) return t("acct.expiresOn", { date: dateText(sub.endTime) });
  return "";
}

/** The badge: the tier while a subscription is active, "PAYG" without one (pay-as-you-go from the balance, whatever the tier). */
export const badgeText = (account: AccountSnapshot): string => (account.subscriptions.length ? tierName(account.tier) || "CGS" : "PAYG");

/** The primary subscription's title, `+N` when there are more; without one, "No subscription". */
export function planTitle(account: AccountSnapshot): string {
  const [first] = account.subscriptions;
  if (!first) return t("acct.noSubscription");
  const title = first.planTitle || t("acct.subscription");
  return account.subscriptions.length > 1 ? `${title} +${account.subscriptions.length - 1}` : title;
}
