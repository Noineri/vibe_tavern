import type { StoreContainer } from "@vibe-tavern/db";
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";
import { SYSTEM_RESOURCE_ID } from "@vibe-tavern/domain";
import { createLoreDelegate, type LoreDelegate } from "../../domain/coauthor/lore/lore-delegate.js";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";

export async function createSessionLoreDelegate(input: {
  stores: StoreContainer;
  activeProfile: StoredProviderProfileRecord | null;
  model: string;
  buildDelegate: typeof createLoreDelegate;
}): Promise<LoreDelegate | undefined> {
  const { stores, activeProfile, model, buildDelegate } = input;
  if (!activeProfile || !model || model === SYSTEM_RESOURCE_ID.unresolvedModel) return undefined;

  const settings = await stores.uiSettings.get();
  const loreProfile =
    settings.coauthorLoreProviderId && settings.coauthorLoreModelName
      ? await stores.providers.getById(settings.coauthorLoreProviderId)
      : null;
  return buildDelegate({
    execute: nonstreamingProviderExecute,
    profile: loreProfile ?? activeProfile,
    model: loreProfile ? settings.coauthorLoreModelName! : model,
  });
}
