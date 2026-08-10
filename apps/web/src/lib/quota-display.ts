/**
 * Presentation helpers for provider quota — shared by the settings panel and
 * the chat-toolbar flyout so both read a window the same way.
 *
 * Nothing here formats prose: countdowns come back as `{ hours, minutes }` (or
 * null) and balances as a symbol/amount pair, and the callers wrap those in
 * i18n keys. Balance amounts stay STRINGS end to end — the domain deliberately
 * never lets money round-trip through a float, and neither does this.
 */

import {
  PROVIDER_BALANCE_UNIT,
  type ProviderBalanceAmount,
  type ProviderQuotaWindowKind,
} from "@vibe-tavern/domain";

/** Colour state of a usage bar. Mirrors the token counter's thresholds. */
export type QuotaUsageState = "ok" | "mid" | "warn";

export function quotaUsageState(usedPercent: number): QuotaUsageState {
  if (usedPercent >= 90) return "warn";
  if (usedPercent >= 75) return "mid";
  return "ok";
}

/** Tailwind fill class for a usage bar in the given state. */
export function quotaBarClass(state: QuotaUsageState): string {
  if (state === "warn") return "bg-danger";
  if (state === "mid") return "bg-warning";
  return "bg-accent";
}

/** Tailwind text class matching {@link quotaBarClass}. */
export function quotaTextClass(state: QuotaUsageState): string {
  if (state === "warn") return "text-danger-text";
  if (state === "mid") return "text-warning-text";
  return "text-t2";
}

export interface QuotaCountdown {
  readonly days: number;
  /** Hours WITHIN the day — 0..23. A weekly window reads "5d 12h", never "132h". */
  readonly hours: number;
  readonly minutes: number;
  /** True once the boundary is in the past — the next poll will report the reset. */
  readonly due: boolean;
}

/**
 * Time until a window's reset boundary, floored to whole minutes.
 *
 * Split into days/hours/minutes so the caller can drop the unit nobody reads at
 * that scale: minutes matter for a five-hour window, days for a weekly one, and
 * "132h 36m" is neither.
 *
 * Returns null for a window that never resets (a spend cap) or a timestamp that
 * does not parse — the caller renders nothing rather than a fabricated "0m".
 */
export function quotaCountdown(resetsAt: string | null, now: number): QuotaCountdown | null {
  if (!resetsAt) return null;
  const target = Date.parse(resetsAt);
  if (Number.isNaN(target)) return null;

  const remainingMs = target - now;
  if (remainingMs <= 0) return { days: 0, hours: 0, minutes: 0, due: true };

  const totalMinutes = Math.floor(remainingMs / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  return {
    days: Math.floor(totalHours / 24),
    hours: totalHours % 24,
    minutes: totalMinutes % 60,
    due: false,
  };
}

/** i18n key for a window kind's display name. Kept exhaustive by the return type. */
export function quotaWindowLabelKey(kind: ProviderQuotaWindowKind): string {
  return `quota_window_${kind}`;
}

/** i18n key for a balance row's display name. */
export function quotaBalanceLabelKey(kind: ProviderBalanceAmount["kind"]): string {
  return `quota_balance_${kind}`;
}

export interface FormattedBalance {
  /** Currency symbol, or null for unit-less vendor credits. */
  readonly symbol: string | null;
  /** The vendor's own decimal string, untouched. */
  readonly amount: string;
  readonly unit: ProviderBalanceAmount["unit"];
}

export function formatBalance(balance: ProviderBalanceAmount): FormattedBalance {
  const symbol = balance.unit === PROVIDER_BALANCE_UNIT.usd
    ? "$"
    : balance.unit === PROVIDER_BALANCE_UNIT.cny
      ? "¥"
      : null;
  return { symbol, amount: balance.amount, unit: balance.unit };
}
