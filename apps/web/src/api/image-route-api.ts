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
