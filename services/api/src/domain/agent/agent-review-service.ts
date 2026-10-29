import { agentReviewEnvelopeSchema, type AgentReviewEnvelope } from "@vibe-tavern/api-contracts";
import type { StoreContainer } from "@vibe-tavern/db";
import { internal, notFound, validation } from "../../shared/errors.js";

/** Review ownership/validation boundary; the DB stores the JSON opaquely. */
export class AgentReviewService {
  constructor(private readonly stores: Pick<StoreContainer, "experienceCopilot" | "agentReviewRounds">) {}

  private async requireThread(threadId: string) {
    if (!await this.stores.experienceCopilot.getById(threadId)) {
      throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
    }
  }

  async get(threadId: string): Promise<AgentReviewEnvelope | null> {
    await this.requireThread(threadId);
    const row = await this.stores.agentReviewRounds.get(threadId);
    if (!row) return null;
    try {
      return agentReviewEnvelopeSchema.parse(JSON.parse(row.envelopeJson));
    } catch (error) {
      // Do not delete or silently serve a corrupt review as a valid empty one.
      throw internal("Stored agent review is invalid.", error);
    }
  }

  async put(threadId: string, envelope: AgentReviewEnvelope): Promise<AgentReviewEnvelope> {
    await this.requireThread(threadId);
    const parsed = agentReviewEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) throw validation("Invalid agent review envelope.");
    await this.stores.agentReviewRounds.put(threadId, JSON.stringify(parsed.data));
    return parsed.data;
  }

  async delete(threadId: string): Promise<{ ok: true }> {
    await this.requireThread(threadId);
    await this.stores.agentReviewRounds.delete(threadId);
    return { ok: true };
  }
}
