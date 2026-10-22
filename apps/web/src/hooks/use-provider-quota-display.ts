import { useEffect } from "react";
import { PROVIDER_QUOTA_KIND } from "@vibe-tavern/domain";
import { selectQuotaEntry, useQuotaStore, type QuotaProfileEntry } from "../stores/quota-store.js";

/**
 * The single "may this profile's quota be shown in chat?" decision, plus the
 * fetch that feeds it.
 *
 * Both chat surfaces read this: the desktop `QuotaIndicator` flyout and the
 * mobile model sheet. A quota surface is visible only when the profile is
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

  return { entry, visible };
}
