import { coauthorReviewEnvelopeSchema, type CoauthorReviewEnvelope } from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { unwrapRpc } from "./unwrap.js";

export async function getCoauthorReview(chatId: string): Promise<CoauthorReviewEnvelope | null> {
  const data = await unwrapRpc(await client.api.chats[":chatId"].coauthor.review.$get({ param: { chatId } }));
  return data === null ? null : coauthorReviewEnvelopeSchema.parse(data);
}

export async function putCoauthorReview(chatId: string, envelope: CoauthorReviewEnvelope): Promise<CoauthorReviewEnvelope> {
  return coauthorReviewEnvelopeSchema.parse(await unwrapRpc(await client.api.chats[":chatId"].coauthor.review.$put({
    param: { chatId }, json: coauthorReviewEnvelopeSchema.parse(envelope),
  })));
}

export async function deleteCoauthorReview(chatId: string): Promise<void> {
  await unwrapRpc(await client.api.chats[":chatId"].coauthor.review.$delete({ param: { chatId } }));
}
