import type { StoreContainer } from '@vibe-tavern/db';
import { COAUTHOR_TRANSPORT, resolveEffectiveSettings } from '@vibe-tavern/domain';
import type { AgentStreamDeps } from '../../domain/agent/agent-stream.js';
import { resolveCachedModels } from '../../domain/providers/model-cache-service.js';
import { resolveModel } from '../../infrastructure/ai/provider-executor-utils.js';
import { resolveVisionDescribePrompt, type AttachmentAssetLoader } from '../../infrastructure/ai/vision-gate.js';
import { notFound } from '../../shared/errors.js';

/** One provider trio for all agent kinds, plus the chat's media field sources.
 * No voice transcriber: the agent shell's scope is images and files (CA-4b2). */
export function buildAgentProviderDeps({ stores, attachmentAssetLoader }: {
  stores: StoreContainer;
  attachmentAssetLoader?: AttachmentAssetLoader;
}): Required<Pick<AgentStreamDeps, 'getProviderProfile' | 'getEffectiveProviderProfile' | 'resolveModel' | 'resolveVisionAssets'>> {
  return {
    getProviderProfile: (id: string) => stores.providers.getById(id),
    getEffectiveProviderProfile: async (id: string, model: string) => {
      const profile = await stores.providers.getById(id);
      if (!profile) {
        throw notFound("ProviderProfile", `Provider profile '${id}' was not found.`);
      }
      if (!profile.bindPerModel) return profile;
      const overlay = await stores.providers.getModelSettings(id, model);
      return resolveEffectiveSettings(profile, overlay?.settings ?? null);
    },
    resolveModel: (
      profile,
      model,
      fetch,
    ) => resolveModel(profile, model, COAUTHOR_TRANSPORT.chatCompletions, fetch),
    resolveVisionAssets: async (profile) => ({
      cachedModels: await resolveCachedModels(stores, profile),
      visionModel: profile.visionModel,
      assetLoader: attachmentAssetLoader,
      visionDescribePrompt: await resolveVisionDescribePrompt(stores.db),
    }),
  };
}
