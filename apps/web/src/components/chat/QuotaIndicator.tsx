import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  PROVIDER_QUOTA_KIND,
  type ProviderBalanceAmount,
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
import { selectQuotaEntry, useQuotaStore } from "../../stores/quota-store.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";

/**
 * Provider-quota flyout for the chat input toolbar — the visible half of the
 * quota feature, sitting immediately right of the context counter.
 *
 * It renders only when the ACTIVE provider profile both supports quota and has
 * the display toggle on (ProviderQuotaPanel). Anything else — an unsupported
 * vendor, the toggle off, a profile whose first poll has not landed yet — means
 * no icon at all rather than an icon that opens onto nothing.
 *
 * Numbers come from the quota store, which is fed by the explicit fetch below
 * and kept current by the global SSE channel; this component never polls.
 */

export interface QuotaIndicatorProps {
  /** The profile the next message will be sent with, or null when none is active. */
  providerProfileId: string | null;
}

export function QuotaIndicator({ providerProfileId }: QuotaIndicatorProps) {
  const { t, tDynamic } = useT();
  const [open, setOpen] = useState(false);
  const entry = useQuotaStore(selectQuotaEntry(providerProfileId ?? ""));

  useEffect(() => {
    if (!providerProfileId) return;
    const { fetchCapability, fetchQuota } = useQuotaStore.getState();
    void fetchCapability(providerProfileId);
    void fetchQuota(providerProfileId);
  }, [providerProfileId]);

  // `now` is sampled when the flyout opens, so the countdowns are current
  // without a ticking interval running behind a closed popover.
  const [openedAt, setOpenedAt] = useState(() => Date.now());

  if (!providerProfileId) return null;
  const config = entry.config;
  if (!config || config.kind === PROVIDER_QUOTA_KIND.none || !config.displayEnabled) return null;

  const snapshot = entry.snapshot;
  const rows = snapshot ? snapshotRows(snapshot) : null;
  const worstUsedPercent = rows && rows.windows.length > 0
    ? Math.max(...rows.windows.map((window) => window.usedPercent))
    : null;
  const triggerState = worstUsedPercent === null ? null : quotaUsageState(worstUsedPercent);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setOpenedAt(Date.now());
        setOpen(next);
      }}
    >
      <CustomTooltip content={t("quota_indicator_tooltip")}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={t("quota_indicator_tooltip")}
            className={cn(
              "flex h-[26px] w-[26px] items-center justify-center rounded-md transition-colors hover:bg-s2 hover:text-t1",
              triggerState ? quotaTextClass(triggerState) : "text-t3",
            )}
          >
            <Icons.quota />
          </button>
        </Popover.Trigger>
      </CustomTooltip>

      <Popover.Portal>
        <Popover.Content
          side="top"
          sideOffset={8}
          align="center"
          className="glass-blur z-[220] w-[248px] rounded-lg border border-border2 bg-glass-bg px-3.5 py-2.5 shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          <div className="mb-1.5 border-b border-border pb-1.5 text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">
            {t("quota_section")}
          </div>

          {entry.lastError && (
            <div className="mb-1.5 text-xs text-danger-text">
              {t(entry.lastError === "auth" ? "quota_error_auth" : "quota_error_poll")}
            </div>
          )}

          {!rows && <div className="py-1 text-xs text-t3">{t("quota_no_data")}</div>}

          {rows?.windows.map((window) => {
            const state = quotaUsageState(window.usedPercent);
            const countdown = quotaCountdown(window.resetsAt, openedAt);
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
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

interface QuotaRows {
  readonly windows: readonly ProviderQuotaWindow[];
  readonly balances: readonly ProviderBalanceAmount[];
}

/** Flatten a snapshot into the two lists this flyout renders. */
function snapshotRows(snapshot: ProviderQuotaSnapshot): QuotaRows | null {
  if (snapshot.kind === PROVIDER_QUOTA_KIND.none) return null;
  if (snapshot.kind === PROVIDER_QUOTA_KIND.balance) {
    return { windows: [], balances: snapshot.balances };
  }
  return { windows: snapshot.windows, balances: snapshot.balances ?? [] };
}
