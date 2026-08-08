import { describe, expect, test } from "bun:test";
import { PROVIDER_BALANCE_KIND, PROVIDER_BALANCE_UNIT } from "@vibe-tavern/domain";
import {
  formatBalance,
  quotaBalanceLabelKey,
  quotaCountdown,
  quotaUsageState,
  quotaWindowLabelKey,
} from "./quota-display.js";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");

describe("quotaUsageState", () => {
  test.each([
    [0, "ok"],
    [74, "ok"],
    [75, "mid"],
    [89, "mid"],
    [90, "warn"],
    [100, "warn"],
  ])("%p%% used is %p", (usedPercent, expected) => {
    expect(quotaUsageState(usedPercent)).toBe(expected as ReturnType<typeof quotaUsageState>);
  });
});

describe("quotaCountdown", () => {
  test("a window that never resets has no countdown", () => {
    expect(quotaCountdown(null, NOW)).toBeNull();
  });

  test("an unparseable instant reports nothing rather than a fabricated zero", () => {
    expect(quotaCountdown("not-a-date", NOW)).toBeNull();
  });

  test("splits the remaining time into whole hours and minutes", () => {
    expect(quotaCountdown("2026-08-08T14:31:30.000Z", NOW))
      .toEqual({ days: 0, hours: 2, minutes: 31, due: false });
  });

  test("hours never exceed a day — a weekly window reads in days", () => {
    // The case that prompted this: 132h 36m is unreadable, 5d 12h is not.
    expect(quotaCountdown("2026-08-14T00:36:00.000Z", NOW))
      .toEqual({ days: 5, hours: 12, minutes: 36, due: false });
  });

  test("exactly 24 hours out is one day, not 24 hours", () => {
    expect(quotaCountdown("2026-08-09T12:00:00.000Z", NOW))
      .toEqual({ days: 1, hours: 0, minutes: 0, due: false });
  });

  test("floors to the minute rather than rounding up", () => {
    expect(quotaCountdown("2026-08-08T12:00:59.000Z", NOW))
      .toEqual({ days: 0, hours: 0, minutes: 0, due: false });
  });

  test("a boundary in the past is due, not negative", () => {
    expect(quotaCountdown("2026-08-08T11:00:00.000Z", NOW))
      .toEqual({ days: 0, hours: 0, minutes: 0, due: true });
  });
});

describe("label keys", () => {
  test("window and balance kinds map onto their i18n keys", () => {
    expect(quotaWindowLabelKey("spend_limit")).toBe("quota_window_spend_limit");
    expect(quotaBalanceLabelKey(PROVIDER_BALANCE_KIND.toppedUp)).toBe("quota_balance_topped_up");
  });
});

describe("formatBalance", () => {
  test("currencies get a symbol and vendor credits do not", () => {
    expect(formatBalance({
      kind: PROVIDER_BALANCE_KIND.available,
      unit: PROVIDER_BALANCE_UNIT.usd,
      amount: "12.40",
      primary: true,
    })).toEqual({ symbol: "$", amount: "12.40", unit: PROVIDER_BALANCE_UNIT.usd });

    expect(formatBalance({
      kind: PROVIDER_BALANCE_KIND.credits,
      unit: PROVIDER_BALANCE_UNIT.credits,
      amount: "1500",
      primary: true,
    })).toEqual({ symbol: null, amount: "1500", unit: PROVIDER_BALANCE_UNIT.credits });
  });

  test("the amount is passed through as the vendor's own string", () => {
    const formatted = formatBalance({
      kind: PROVIDER_BALANCE_KIND.total,
      unit: PROVIDER_BALANCE_UNIT.cny,
      amount: "0.30",
      primary: true,
    });
    expect(formatted.amount).toBe("0.30");
    expect(formatted.symbol).toBe("¥");
  });
});
