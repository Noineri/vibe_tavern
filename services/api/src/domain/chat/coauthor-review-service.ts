// fork #1 of AgentReviewService (domain/agent/agent-review-service.ts).
// Planned differences: chat/mode ownership, CA-15 envelope, native-result producer.
import { coauthorReviewEnvelopeSchema, buildCoauthorReviewEnvelope, coauthorReviewActivityFromResult, type CoauthorReviewEnvelope } from "@vibe-tavern/api-contracts";
import type { StoreContainer } from "@vibe-tavern/db";
import { internal, notFound, validation } from "../../shared/errors.js";

export class CoauthorReviewService {
  constructor(private readonly stores: Pick<StoreContainer, "chats" | "agentReviewRounds">) {}

  private async requireChat(chatId: string) {
    const chat = await this.stores.chats.getById(chatId);
    if (!chat || chat.mode !== "coauthor") throw notFound("CoauthorChat", `Co-Author chat '${chatId}' was not found.`);
  }

  async get(chatId: string): Promise<CoauthorReviewEnvelope | null> {
    await this.requireChat(chatId);
    const row = await this.stores.agentReviewRounds.getChat(chatId);
    if (!row) return null;
    try { return coauthorReviewEnvelopeSchema.parse(JSON.parse(row.envelopeJson)); }
    catch (error) { throw internal("Stored Co-Author review is invalid.", error); }
  }

  async put(chatId: string, envelope: CoauthorReviewEnvelope): Promise<CoauthorReviewEnvelope> {
    await this.requireChat(chatId);
    const parsed = coauthorReviewEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) throw validation("Invalid Co-Author review envelope.");
    await this.stores.agentReviewRounds.putChat(chatId, JSON.stringify(parsed.data));
    return parsed.data;
  }

  async delete(chatId: string): Promise<{ ok: true }> {
    await this.requireChat(chatId);
    await this.stores.agentReviewRounds.deleteChat(chatId);
    return { ok: true };
  }

  /** No proposals means no write: preserve prior review bytes AND timestamp. */
  async persistResults(chatId: string, results: ReadonlyArray<Parameters<typeof coauthorReviewActivityFromResult>[0]>): Promise<void> {
    if ((await this.stores.chats.getById(chatId))?.mode !== "coauthor") return;
    const envelope = buildCoauthorReviewEnvelope(results.map(coauthorReviewActivityFromResult));
    if (envelope) await this.put(chatId, envelope);
  }
}
