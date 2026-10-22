import { useEffect } from "react";
import { PROVIDER_QUOTA_KIND } from "@vibe-tavern/domain";
import { selectQuotaEntry, useQuotaStore, type QuotaProfileEntry } from "../stores/quota-store.js";
import { quotaUsageState, type QuotaUsageState } from "../lib/quota-display.js";
import { snapshotRows } from "../components/shared/QuotaSummaryRows.js";

/**
 * The single "may this profile's quota be shown in chat?" decision, plus the
 * fetch that feeds it.
 *
 * Every chat quota surface reads this: the desktop `QuotaIndicator` flyout,
 * the mobile model sheet and the model button's warning dot. A quota surface is visible only when the profile is
 * known, its quota config says the provider supports quota (kind is not
 * `none`) and its display toggle is on. A profile whose config has not landed
 * yet is NOT visible — an empty box is worse than nothing.
 *
 * The effect fetches the capability and the current quota once per profile
 * (the host mounts the hook when the surface appears); the global SSE channel
 * keeps the store current afterwards, so nothing here polls.
 */
export interface ProviderQuotaDisplay {
  /** The store entry for the profile (an empty entry when none is active). */
  entry: QuotaProfileEntry;
  /** Supported AND display toggle on — the gate every quota surface shares. */
  visible: boolean;
  /** The WORST window's usage state (the same thresholds that color the
   *  desktop indicator), or null while there is no snapshot or it has no
   *  windows (a balance-only vendor). The one place this is computed. */
  worstState: QuotaUsageState | null;
}

export function useProviderQuotaDisplay(providerProfileId: string | null): ProviderQuotaDisplay {
  const entry = useQuotaStore(selectQuotaEntry(providerProfileId ?? ""));

  useEffect(() => {
    if (!providerProfileId) return;
    const { fetchCapability, fetchQuota } = useQuotaStore.getState();
    void fetchCapability(providerProfileId);
    void fetchQuota(providerProfileId);
  }, [providerProfileId]);

  const config = entry.config;
  const visible = providerProfileId !== null
    && config !== null
    && config.kind !== PROVIDER_QUOTA_KIND.none
    && config.displayEnabled;

  const rows = entry.snapshot ? snapshotRows(entry.snapshot) : null;
  const worstState = rows && rows.windows.length > 0
    ? quotaUsageState(Math.max(...rows.windows.map((window) => window.usedPercent)))
    : null;

  return { entry, visible, worstState };
}
