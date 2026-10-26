import type { StoreContainer } from '@vibe-tavern/db';
import { COAUTHOR_TRANSPORT, resolveEffectiveSettings } from '@vibe-tavern/domain';
import type { CopilotProfile } from '@vibe-tavern/api-contracts';
import type { AgentStreamDeps } from '../../domain/agent/agent-stream.js';
import type { AgentOwnModelBinding } from '../../domain/agent/agent-own-model.js';
import { resolveCachedModels } from '../../domain/providers/model-cache-service.js';
import { resolveModel } from '../../infrastructure/ai/provider-executor-utils.js';
import { resolveVisionDescribePrompt, type AttachmentAssetLoader } from '../../infrastructure/ai/vision-gate.js';
import { notFound } from '../../shared/errors.js';

/** One provider trio for all agent kinds, plus the chat's media field sources.
 * No voice transcriber: the agent shell's scope is images and files (CA-4b2).
 * DR-2 (M1) adds `getAgentOwnModel` — the ONE wiring of the per-profile
 * own-model read every kind's stream deps spreads in. */
export function buildAgentProviderDeps({ stores, attachmentAssetLoader }: {
  stores: StoreContainer;
  attachmentAssetLoader?: AttachmentAssetLoader;
}): Required<Pick<AgentStreamDeps, 'getProviderProfile' | 'getEffectiveProviderProfile' | 'resolveModel' | 'resolveVisionAssets'>> & {
  getAgentOwnModel: (profile: CopilotProfile) => Promise<AgentOwnModelBinding | null>;
} {
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
    // DR-2 (M1): the profile's own-model row keyed by the resolved profile's
    // own (kind, id) — null when none is stored (same as sidechat). The row's
    // dangling-provider fall-through is applied by the generic loop, together
    // with the rest of the model chain.
    getAgentOwnModel: (profile) => stores.agentProfileModels.get(profile.agentKind, profile.id),
  };
}
