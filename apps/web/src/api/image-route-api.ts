import type { ImageRoute } from '@vibe-tavern/domain';
import { getGatewayBaseUrl } from './client.js';
import { appendTokenQuery } from '../lib/mobile-token.js';
import { unwrapError } from './unwrap.js';

export async function fetchChatImageRoute(chatId: string): Promise<ImageRoute> {
  const response = await fetch(appendTokenQuery(`${getGatewayBaseUrl()}/api/chats/${encodeURIComponent(chatId)}/image-route`));
  if (!response.ok) throw await unwrapError(response);
  const result: { route: ImageRoute } = await response.json();
  return result.route;
}

/** The shell's profile-level twin (CA-4e1): the agent shell sends
 *  `providerProfileId` + `model` per turn and has no chat to resolve. */
export async function fetchProfileImageRoute(providerProfileId: string, model?: string): Promise<ImageRoute> {
  const query = new URLSearchParams({ providerProfileId });
  if (model !== undefined) query.set("model", model);
  const response = await fetch(appendTokenQuery(`${getGatewayBaseUrl()}/api/experience-copilot/image-route?${query.toString()}`));
  if (!response.ok) throw await unwrapError(response);
  const result: { route: ImageRoute } = await response.json();
  return result.route;
}
