import type { StoreContainer } from "@vibe-tavern/db";
import { resolveCoauthorGenerationProfile, SYSTEM_RESOURCE_ID } from "@vibe-tavern/domain";
import { createLoreDelegate, type LoreDelegate } from "../../domain/coauthor/lore/lore-delegate.js";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";

export async function createSessionLoreDelegate(input: {
  stores: StoreContainer;
  buildDelegate: typeof createLoreDelegate;
}): Promise<LoreDelegate | undefined> {
  const { stores, buildDelegate } = input;
  if (!stores?.uiSettings || !stores.providers || !stores.coauthorSettings) return undefined;

  const settings = await stores.uiSettings.get();
  const loreProfile =
    settings.coauthorLoreProviderId && settings.coauthorLoreModelName
      ? await stores.providers.getById(settings.coauthorLoreProviderId)
      : null;
  const coauthorProfile = settings.coauthorProviderId
    ? await stores.providers.getById(settings.coauthorProviderId)
    : null;
  const profile = loreProfile ?? coauthorProfile;
  if (!profile) return undefined;

  const coauthorSettings = await stores.coauthorSettings.getByProviderId(profile.id);
  const model = loreProfile
    ? settings.coauthorLoreModelName!
    : coauthorSettings?.modelName ?? profile.defaultModel;
  if (!model || model === SYSTEM_RESOURCE_ID.unresolvedModel) return undefined;

  return buildDelegate({
    execute: nonstreamingProviderExecute,
    profile: resolveCoauthorGenerationProfile(profile, model, coauthorSettings?.settings),
    model,
  });
}
