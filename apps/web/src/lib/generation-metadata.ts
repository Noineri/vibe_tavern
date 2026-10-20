import { getT } from "../i18n/locale-helpers.js";
import { resolveCoauthorBinding } from "./coauthor-provider-binding.js";
import { useBootstrapStore } from "../stores/api-actions/bootstrap-actions.js";
import { useProviderDataStore } from "../stores/provider-data-store.js";
import { useProviderStore } from "../stores/provider-store.js";
import { useSnapshotStore } from "../stores/snapshot-store.js";

export interface GenerationMetadata {
  modelId: string | null;
  presetName: string | null;
}

/** Snapshot the model and preset currently shown by the chat quick switches. */
export function captureQuickSwitchGenerationMetadata(chatId: string): GenerationMetadata {
  const snapshot = useSnapshotStore.getState();
  const activeChat = snapshot.activeChat?.id === chatId ? snapshot.activeChat : null;
  const bootstrap = useBootstrapStore.getState().data;
  const profiles = useProviderDataStore.getState();
  const modelId = activeChat?.mode === "coauthor"
    ? resolveCoauthorBinding({
      coauthorProviderId: bootstrap?.uiSettings.coauthorProviderId ?? null,
      coauthorSettings: (() => {
        const profileId = bootstrap?.uiSettings.coauthorProviderId;
        return profileId ? profiles.coauthorSettingsByProfile[profileId] : undefined;
      })(),
      profiles: profiles.profiles,
    }).model
    : profiles.profiles.find((profile) => profile.isActive)?.defaultModel || useProviderStore.getState().connection.model || null;
  const presetName = bootstrap?.promptPresets?.find((preset) => preset.id === activeChat?.promptPresetId)?.name
    ?? getT()("topbar_default");
  return { modelId, presetName };
}
