import type { StoreContainer } from "@vibe-tavern/db";
import type { AgentRunOwner } from "@vibe-tavern/domain";
import type { ChatMessageRuntimeApi } from "../contract/chat-runtime-contracts.js";
import { AgentRunActiveError, type AgentRunRegistry } from "../../domain/agent/agent-run-registry.js";
import { ChatGenerationQueue } from "../../domain/chat/chat-generation-queue.js";
import { ChatGenerationRunAdapter } from "./chat-generation-run-adapter.js";

/** Wiring only: queue policy lives in domain/chat and the actual regenerate
 * implementation remains ChatAdapter's existing profile/orchestrator path. */
export abstract class ChatGenerationQueueAdapter extends ChatGenerationRunAdapter {
  readonly generationQueue: ChatGenerationQueue;
  abstract regenerateMessageStream: ChatMessageRuntimeApi["regenerateMessageStream"];

  constructor(stores: StoreContainer, registry?: AgentRunRegistry<AgentRunOwner>) {
    super(stores, registry);
    this.generationQueue = new ChatGenerationQueue({ stores, registry: this.agentRuns,
      start: (job, branch, turn) => this.startOwnedChatGeneration(job.chatId, { operation: "regenerate", messageId: job.messageId }, turn, undefined, branch),
      regenerate: (job, signal) => this.regenerateMessageStream(job.chatId, job.messageId,
        { model: job.model, ...(job.promptPresetId ? { promptPresetId: job.promptPresetId } : {}) }, signal),
    });
  }

  getGenerationQueue: ChatMessageRuntimeApi["getGenerationQueue"] = (id) => this.generationQueue.list(id);
  enqueueGenerationJob: ChatMessageRuntimeApi["enqueueGenerationJob"] = (id, body) => this.generationQueue.enqueue(id, body);
  cancelGenerationJob: ChatMessageRuntimeApi["cancelGenerationJob"] = (id, job) => this.generationQueue.cancel(id, job);
  clearGenerationQueue: ChatMessageRuntimeApi["clearGenerationQueue"] = (id) => this.generationQueue.clear(id);

  protected assertGenerationIdle(chatId: string): void {
    if (this.agentRuns.active().some((run) => run.threadId === `chat:${chatId}`)) throw new AgentRunActiveError(`chat:${chatId}`);
  }
}
