import type { StoreContainer } from "@vibe-tavern/db";
import type { AgentRunOwner } from "@vibe-tavern/domain";
import type { ChatMessageRuntimeApi } from "../contract/chat-runtime-contracts.js";
import type { AgentRunRegistry } from "../../domain/agent/agent-run-registry.js";
import { ChatGenerationQueue } from "../../domain/chat/chat-generation-queue.js";
import { ChatGenerationRunAdapter } from "./chat-generation-run-adapter.js";
import type { ChatGenerationOperation } from "@vibe-tavern/api-contracts";

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

  /** Native requests must occupy the SAME slot as detached streams: otherwise
   * queue job #1 could overlap a non-streaming standalone regenerate (#0).
   * Their request cancellation contract stays intact; replay shows context and
   * then refreshes the saved result, without manufacturing text deltas. */
  protected async runNativeGeneration<T>(chatId: string, operation: ChatGenerationOperation, requestSignal: AbortSignal | undefined, produce: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let result!: T;
    let failure: { error: unknown } | undefined;
    const subscription = await this.startOwnedChatGeneration(chatId, operation, async function* (ownedSignal) {
      try {
        result = await produce(requestSignal ? AbortSignal.any([ownedSignal, requestSignal]) : ownedSignal);
        yield { event: "finish", data: '{"finishReason":"stop"}' };
      } catch (error) { failure = { error }; throw error; }
    }, undefined, undefined, true);
    for await (const _frame of subscription) { /* Join the registry's persistence/slot release. */ }
    if (failure) throw failure.error;
    return result;
  }
}
