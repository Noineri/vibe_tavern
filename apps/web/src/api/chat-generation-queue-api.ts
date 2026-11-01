import { chatGenerationJobSchema, enqueueChatGenerationJobSchema, type ChatGenerationJob, type EnqueueChatGenerationJobRequest } from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";

export async function getGenerationQueue(chatId: string): Promise<ChatGenerationJob[]> {
  return chatGenerationJobSchema.array().parse(await unwrapRpc(await client.api.chats[":chatId"].queue.$get({ param: { chatId } })));
}
export async function enqueueGenerationJob(chatId: string, input: EnqueueChatGenerationJobRequest): Promise<ChatGenerationJob> {
  return chatGenerationJobSchema.parse(await unwrapRpc(await client.api.chats[":chatId"].queue.$post({ param: { chatId }, json: enqueueChatGenerationJobSchema.parse(input) })));
}
export async function cancelGenerationJob(chatId: string, jobId: string): Promise<void> {
  await unwrapRpc(await client.api.chats[":chatId"].queue[":jobId"].$delete({ param: { chatId, jobId } }));
}
export async function clearGenerationQueue(chatId: string): Promise<void> {
  await unwrapRpc(await client.api.chats[":chatId"].queue.clear.$post({ param: { chatId } }));
}
