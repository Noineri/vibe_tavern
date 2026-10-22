// The red dot on the mobile model button. ONE decision for both signals it
// stands for: the context nearly full (`tokenState === "warn"`, the state that
// used to turn the ring red) or the active provider's quota nearly used up
// (its worst window is `warn`). No numbers of its own — it reads the two
// states that already exist.
//
// The quota half counts only while the quota is VISIBLE by the shared gate
// (supported + display toggle on, hooks/use-provider-quota-display.ts): a
// hidden quota must never light a dot nobody can explain.

import { useProviderQuotaDisplay, type ProviderQuotaDisplay } from "../../hooks/use-provider-quota-display.js";
import type { TokenCounterPopoverProps } from "../shared/TokenCounterPopover.js";

export function modelButtonWarning(
  tokenState: TokenCounterPopoverProps["tokenState"],
  quota: Pick<ProviderQuotaDisplay, "visible" | "worstState">,
): boolean {
  return tokenState === "warn" || (quota.visible && quota.worstState === "warn");
}

export function useModelButtonWarning(
  tokenState: TokenCounterPopoverProps["tokenState"],
  providerProfileId: string | null,
): boolean {
  return modelButtonWarning(tokenState, useProviderQuotaDisplay(providerProfileId));
}
