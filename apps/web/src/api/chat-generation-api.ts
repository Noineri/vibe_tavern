import { isAgentThreadRunning } from "./agent-run-api.js";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";
import { streamReplayEndpoint, type StreamOpts } from "./stream.js";

export function isChatGenerationRunning(chatId: string, signal?: AbortSignal) {
  return isAgentThreadRunning(`chat:${chatId}`, signal);
}

export function subscribeChatGeneration(chatId: string, after: number, opts: StreamOpts) {
  return streamReplayEndpoint(`/api/chats/${encodeURIComponent(chatId)}/generation`, after, { ...opts, waitForStreamEnd: true });
}

export async function stopChatGeneration(chatId: string): Promise<{ stopped: boolean }> {
  return unwrapRpc(await client.api.chats[":chatId"].generation.stop.$post({ param: { chatId } }));
}
