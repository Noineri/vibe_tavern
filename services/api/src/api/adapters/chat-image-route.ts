import type { StoreContainer } from '@vibe-tavern/db';
import { modelSeesImages, resolveImageRoute, type ImageRoute, type StoredProviderProfileRecord } from '@vibe-tavern/domain';
import { resolveCachedModels } from '../../domain/providers/model-cache-service.js';
import { notFound } from '../../shared/errors.js';

/** Uses the SEND resolver, not a second RP/Co-Author connection derivation. */
export async function resolveChatImageRoute(
  stores: StoreContainer,
  chatId: string,
  resolveProfile: (chatId: string) => Promise<{ profile: StoredProviderProfileRecord & { defaultModel: string } }>,
): Promise<{ route: ImageRoute }> {
  if (!await stores.chats.getById(chatId)) throw notFound('Chat', `Chat '${chatId}' was not found.`);
  const { profile } = await resolveProfile(chatId);
  const cachedModels = await resolveCachedModels(stores, profile);
  return { route: resolveImageRoute({ seesImages: modelSeesImages(cachedModels, profile.defaultModel), visionModel: profile.visionModel }) };
}
