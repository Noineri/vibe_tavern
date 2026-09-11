import {
  PROVIDER_QUOTA_KIND,
  type ProviderBalanceAmount,
  type ProviderQuotaErrorKind,
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
} from "@vibe-tavern/domain";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import {
  formatBalance,
  quotaBalanceLabelKey,
  quotaBarClass,
  quotaCountdown,
  quotaTextClass,
  quotaUsageState,
  quotaWindowLabelKey,
} from "../../lib/quota-display.js";

/**
 * Presentational quota snapshot — the shared body of every quota view.
 *
 * Extracted from the chat-input flyout (QuotaIndicator) for MUI step 4
 * (2026-09-11): on phones the chat toolbar has no room for the flyout, so the
 * provider profile (settings) must also show the current numbers. Both
 * surfaces render the identical body — error line, windowed usage bars with
 * countdowns, money/credit balances — from the same quota-store snapshot.
 *
 * Pure presentation: no store access, no fetching. The caller owns the data
 * (QuotaIndicator / ProviderQuotaPanel both already hold the store entry) and
 * the `now` sample used for countdowns (sampled on open, not on a ticking
 * interval, so a closed surface runs no timers).
 */
export interface QuotaSummaryRowsProps {
  snapshot: ProviderQuotaSnapshot | null;
  lastError: ProviderQuotaErrorKind | null;
  /** Timestamp the countdowns are computed against (sampled when the surface opens). */
  now: number;
}

export function QuotaSummaryRows({ snapshot, lastError, now }: QuotaSummaryRowsProps) {
  const { t, tDynamic } = useT();

  const rows = snapshot ? snapshotRows(snapshot) : null;

  return (
    <>
      {lastError && (
        <div className="mb-1.5 text-xs text-danger-text">
          {t(lastError === "auth" ? "quota_error_auth" : "quota_error_poll")}
        </div>
      )}

      {!rows && <div className="py-1 text-xs text-t3">{t("quota_no_data")}</div>}

      {rows?.windows.map((window) => {
        const state = quotaUsageState(window.usedPercent);
        const countdown = quotaCountdown(window.resetsAt, now);
        return (
          <div key={window.kind} className="mb-2 last:mb-0">
            <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-t2" title={window.label}>
                {tDynamic(quotaWindowLabelKey(window.kind))}
              </span>
              <span className={cn("shrink-0 tabular-nums", quotaTextClass(state))}>
                {t("quota_remaining_value", { percent: Math.round(100 - window.usedPercent) })}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-s3">
              <div
                className={cn("h-full", quotaBarClass(state))}
                style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
              />
            </div>
            <div className="mt-1 text-[10px] text-t4">
              {countdown === null
                ? t("quota_no_reset")
                : countdown.due
                  ? t("quota_resets_due")
                  // Past a day the minutes are noise; below it they are the point.
                  : countdown.days > 0
                    ? t("quota_resets_in_days", { days: countdown.days, hours: countdown.hours })
                    : t("quota_resets_in", { hours: countdown.hours, minutes: countdown.minutes })}
            </div>
          </div>
        );
      })}

      {rows && rows.balances.length > 0 && (
        <div className={cn(rows.windows.length > 0 && "mt-2 border-t border-border pt-1.5")}>
          {rows.balances.map((balance) => {
            const formatted = formatBalance(balance);
            return (
              <div key={balance.kind} className="mb-1 flex justify-between gap-2 text-xs last:mb-0">
                <span className="truncate text-t2">{tDynamic(quotaBalanceLabelKey(balance.kind))}</span>
                <span className={cn("shrink-0 tabular-nums", balance.primary ? "font-medium text-t1" : "text-t2")}>
                  {formatted.symbol
                    ? `${formatted.symbol}${formatted.amount}`
                    : t("quota_credits_value", { amount: formatted.amount })}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

interface QuotaRows {
  readonly windows: readonly ProviderQuotaWindow[];
  readonly balances: readonly ProviderBalanceAmount[];
}

/** Flatten a snapshot into the two lists every quota surface renders. */
export function snapshotRows(snapshot: ProviderQuotaSnapshot): QuotaRows | null {
  if (snapshot.kind === PROVIDER_QUOTA_KIND.none) return null;
  if (snapshot.kind === PROVIDER_QUOTA_KIND.balance) {
    return { windows: [], balances: snapshot.balances };
  }
  return { windows: snapshot.windows, balances: snapshot.balances ?? [] };
}
