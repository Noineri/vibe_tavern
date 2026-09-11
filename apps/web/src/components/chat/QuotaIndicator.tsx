import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { PROVIDER_QUOTA_KIND } from "@vibe-tavern/domain";
import { useT } from "../../i18n/context.js";
import { cn } from "../../lib/cn.js";
import { quotaTextClass, quotaUsageState } from "../../lib/quota-display.js";
import { selectQuotaEntry, useQuotaStore } from "../../stores/quota-store.js";
import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";
import { QuotaSummaryRows, snapshotRows } from "../shared/QuotaSummaryRows.js";

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
 * The popover body is the shared {@link QuotaSummaryRows} — the same snapshot
 * presentation the provider profile (settings) renders on mobile (MUI step 4).
 */

export interface QuotaIndicatorProps {
  /** The profile the next message will be sent with, or null when none is active. */
  providerProfileId: string | null;
}

export function QuotaIndicator({ providerProfileId }: QuotaIndicatorProps) {
  const { t } = useT();
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
          className="glass-blur z-[220] w-[248px] rounded-lg border border-border2 bg-glass-bg px-3.5 py-2.5 shadow-[0_12px_28px_rgba(0,0,0,0.45)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-in-95"
        >
          <div className="mb-1.5 border-b border-border pb-1.5 text-[calc(var(--ui-fs)-3px)] font-medium uppercase tracking-[0.08em] text-t3">
            {t("quota_section")}
          </div>

          <QuotaSummaryRows snapshot={entry.snapshot} lastError={entry.lastError} now={openedAt} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
