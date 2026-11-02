import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { patchUiSettingsAction, useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";

/**
 * SUM-4 pin binding for the Summary tab — the pinned provider/model pair
 * (ui_settings `summaryProviderId` + `summaryModelName`), extracted from
 * SummaryTab.tsx with the 2026-11 "old model resurrects" incident fix.
 *
 * Owns:
 *  - the four selection states (useChatModel, provider, model, pinnedModel);
 *  - hydration-on-open from the persisted pair (a dangling provider id —
 *    profile deleted since — falls through to the follow-chat-model default
 *    instead of wedging the picker on a ghost row);
 *  - the two persistence writes (clear / re-pin).
 *
 * Incident contract (pinned by SummaryTab.pin-persistence.test.tsx):
 *  1. Pin writes MUST go through patchUiSettingsAction, never the bare
 *     updateUiSettings API — a write that skips the bootstrap store leaves
 *     the STALE pair living in it, and hydration re-applies that stale pair
 *     afterwards (the unpin that "didn't stick"; the model that snapped back
 *     to the old pair after generate / modal close / toggle).
 *  2. The hydration effect MUST NOT key on the `providers` ARRAY — AppShell
 *     maps a fresh array every render, so array identity re-ran hydration on
 *     every parent re-render. It keys on a provider-IDS string instead:
 *     re-runs only when the actual profile set changes (preserving the
 *     dangling-id re-validation), never on identity churn.
 */
export interface SummaryPinBinding {
  useChatModel: boolean;
  setUseChatModel: Dispatch<SetStateAction<boolean>>;
  selectedProviderId: string;
  selectedModel: string;
  pinnedModel: string | null;
  setSelectedProviderId: Dispatch<SetStateAction<string>>;
  setSelectedModel: Dispatch<SetStateAction<string>>;
  setPinnedModel: Dispatch<SetStateAction<string | null>>;
  /** Unpin / provider switch: clear the persisted pair (server + store). */
  clearPersistedPin: () => void;
  /** Re-pin: persist the pair through the store-merging action. */
  persistPinnedPair: (providerId: string | null, modelName: string) => void;
}

export function useSummaryPinBinding(options: {
  isOpen: boolean;
  providers: Array<{ id: string }>;
  initialProviderId: string;
  initialModel: string;
}): SummaryPinBinding {
  const { isOpen, providers, initialProviderId, initialModel } = options;
  const bootstrapUiSettings = useBootstrapStore((s) => s.data?.uiSettings ?? null);
  const [useChatModel, setUseChatModel] = useState(true);
  const [selectedProviderId, setSelectedProviderId] = useState(initialProviderId);
  const [selectedModel, setSelectedModel] = useState(initialModel);
  // The pin is PERSISTED (ui_settings summary pair), not ephemeral — it
  // survives modal close/reopen. Null = follow the chat model (unpinned).
  const [pinnedModel, setPinnedModel] = useState<string | null>(null);

  // SUM-4 hydration: a persisted summary binding (provider + model) restores
  // the pinned selection on open — the exact state the star wrote last time.
  // See the header's incident contract for why the dep is the ids STRING.
  const providerIdsKey = providers.map((p) => p.id).join("\n");
  useEffect(() => {
    if (!isOpen) return;
    const storedProviderId = bootstrapUiSettings?.summaryProviderId ?? null;
    const storedModelName = bootstrapUiSettings?.summaryModelName ?? null;
    if (storedProviderId && storedModelName) {
      const providerExists = providers.some((p) => p.id === storedProviderId);
      if (providerExists) {
        setUseChatModel(false);
        setSelectedProviderId(storedProviderId);
        setSelectedModel(storedModelName);
        setPinnedModel(storedModelName);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- providers is read for the dangling-id check; providerIdsKey carries its identity
  }, [isOpen, bootstrapUiSettings?.summaryProviderId, bootstrapUiSettings?.summaryModelName, providerIdsKey]);

  function clearPersistedPin(): void {
    void patchUiSettingsAction({ summaryProviderId: null, summaryModelName: null }).catch(() => {});
  }

  function persistPinnedPair(providerId: string | null, modelName: string): void {
    void patchUiSettingsAction({ summaryProviderId: providerId, summaryModelName: modelName }).catch(() => {});
  }

  return {
    useChatModel,
    setUseChatModel,
    selectedProviderId,
    selectedModel,
    pinnedModel,
    setSelectedProviderId,
    setSelectedModel,
    setPinnedModel,
    clearPersistedPin,
    persistPinnedPair,
  };
}
