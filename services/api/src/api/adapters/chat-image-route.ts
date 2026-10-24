import type { StoreContainer } from '@vibe-tavern/db';
import { modelSeesImages, resolveImageRoute, type ImageRoute, type StoredProviderProfileRecord } from '@vibe-tavern/domain';
import { resolveCachedModels } from '../../domain/providers/model-cache-service.js';
import type { ProviderProfileService } from '../../domain/providers/provider-profile-service.js';
import { notFound, validation } from '../../shared/errors.js';

/** The part of the image-route rule after the profile + model are known
 *  (CA-4e1): loads the cached model list and applies the ONE domain rule
 *  (`modelSeesImages` + `resolveImageRoute`). Both the chat path (which
 *  resolves its profile+model from the chat) and the shell's profile-level
 *  route read this — no second derivation of the rule. */
export async function imageRouteForProfile(
  stores: StoreContainer,
  profile: StoredProviderProfileRecord,
  model: string,
): Promise<{ route: ImageRoute }> {
  const cachedModels = await resolveCachedModels(stores, profile);
  return { route: resolveImageRoute({ seesImages: modelSeesImages(cachedModels, model), visionModel: profile.visionModel }) };
}

/** The shell's profile-level twin of the chat image route (CA-4e1): the shell
 *  sends `providerProfileId` + `model` per turn and has no chat to resolve.
 *  Model = the query's model, else the profile's default; none is a validation
 *  error, an unknown profile the shared not-found family. */
export async function resolveProfileImageRoute(
  stores: StoreContainer,
  providers: ProviderProfileService,
  providerProfileId: string,
  model?: string,
): Promise<{ route: ImageRoute }> {
  const profile = await providers.getProviderProfile(providerProfileId);
  if (!profile) throw notFound('ProviderProfile', `Provider profile '${providerProfileId}' was not found.`);
  const resolvedModel = (model ?? profile.defaultModel ?? '').trim();
  if (!resolvedModel) throw validation('Select a model to resolve the image route.');
  return imageRouteForProfile(stores, profile, resolvedModel);
}

/** Uses the SEND resolver, not a second RP/Co-Author connection derivation. */
export async function resolveChatImageRoute(
  stores: StoreContainer,
  chatId: string,
  resolveProfile: (chatId: string) => Promise<{ profile: StoredProviderProfileRecord & { defaultModel: string } }>,
): Promise<{ route: ImageRoute }> {
  if (!await stores.chats.getById(chatId)) throw notFound('Chat', `Chat '${chatId}' was not found.`);
  const { profile } = await resolveProfile(chatId);
  return imageRouteForProfile(stores, profile, profile.defaultModel);
}
