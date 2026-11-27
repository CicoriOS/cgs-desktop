import { describe, expect, it } from "vitest";
import type { AccountSnapshot, Subscription } from "../src/core/types";
import { badgeText, planTimeText, planTitle, toneOf, usedPercent } from "../src/ui/account";
import { avatarColor, avatarLetter } from "../src/ui/avatar";
import { setLocale } from "../src/i18n";

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  id: 1, planTitle: "Pro", unlimited: false, amountUsed: 25, amountTotal: 100, usedDisplay: "", totalDisplay: "", resetPeriod: "never", nextResetAt: 0, endTime: 0, ...over,
});
const account = (subscriptions: Subscription[]): AccountSnapshot => ({ username: "u", tier: "pro", balance: "¥1", subscriptions, stale: false, fetchedAt: 0 });

setLocale("en");

describe("plan usage", () => {
  it("has no percentage for an unlimited plan and caps an overdrawn one at 100", () => {
    expect(usedPercent(sub({ unlimited: true, amountTotal: 0 }))).toBe(0);
    expect(usedPercent(sub({ amountUsed: 130 }))).toBe(100);
    expect(toneOf(49)).toBe("ok");
    expect(toneOf(50)).toBe("warn");
    expect(toneOf(80)).toBe("high");
  });

  it("calls an account without a subscription pay-as-you-go, whatever its tier", () => {
    expect(badgeText(account([]))).toBe("PAYG");
    expect(badgeText(account([sub()]))).toBe("Pro");
    expect(planTitle(account([sub(), sub({ id: 2 })]))).toBe("Pro +1");
  });

  it("shows the next reset, or the end date when the plan never resets", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(planTimeText(sub({ resetPeriod: "monthly", nextResetAt: now / 1000 + 12 * 86_400 }), now)).toBe("Resets in 12 d");
    expect(planTimeText(sub({ endTime: Date.UTC(2026, 5, 15, 12) / 1000 }), now)).toBe("Expires 2026-06-15");
    expect(planTimeText(sub(), now)).toBe("");
  });
});

describe("avatar placeholder", () => {
  it("matches the CGS console: first letter upper-cased, a stable colour per name", () => {
    expect(avatarLetter(" alice")).toBe("A");
    expect(avatarLetter("")).toBe("?");
    expect(avatarColor("alice")).toBe(avatarColor("alice"));
    expect(avatarColor("alice")).not.toBe(avatarColor("bob"));
  });
});
