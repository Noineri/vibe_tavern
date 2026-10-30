/** BR-4a: chat execution uses the same registry and lifecycle channel as agent
 * threads. HTTP owns only the subscription; all turn inputs live in its factory. */
import type { StoreContainer } from "@vibe-tavern/db";
import type { AgentRunOwner } from "@vibe-tavern/domain";
import { DiceBindError, ExperienceBindError } from "@vibe-tavern/db";
import { AgentRunRegistry } from "../../domain/agent/agent-run-registry.js";
import type { ChatGenerationTurn, ChatMessageRuntimeApi } from "../contract/chat-runtime-contracts.js";
import { notFound } from "../../shared/errors.js";
import { extractProviderErrorMessage } from "../../infrastructure/ai/provider-error-message.js";
import { classifyProviderError } from "../../infrastructure/ai/provider-error-classifier.js";
import { logSendDebug } from "../../shared/send-debug-log.js";
import { chatGenerationContextSchema, type ChatGenerationContext } from "@vibe-tavern/api-contracts";

export class ChatGenerationRunAdapter {
  constructor(
    private readonly runStores: Pick<StoreContainer, "chats" | "characters">,
    readonly agentRuns = new AgentRunRegistry<AgentRunOwner>(),
  ) {}

  startChatGeneration: ChatMessageRuntimeApi["startChatGeneration"] = async (chatId, operation, turn, subscriberSignal) => {
    return this.startOwnedChatGeneration(chatId, operation, turn, subscriberSignal);
  };

  /** Queue targets keep their message's branch even after navigation. HTTP
   * callers cannot choose this internal scope override. */
  protected async startOwnedChatGeneration(chatId: string, operation: Parameters<ChatMessageRuntimeApi["startChatGeneration"]>[1], turn: ChatGenerationTurn, subscriberSignal?: AbortSignal, branchId?: string) {
    const chat = await this.runStores.chats.getById(chatId);
    if (!chat) throw notFound("Chat", `Chat '${chatId}' was not found.`);
    const character = await this.runStores.characters.getById(chat.characterId);
    const key = chatGenerationKey(chatId);
    const context = chatGenerationContextSchema.parse({ ...operation, chatId, branchId: branchId ?? chat.activeBranchId, runId: crypto.randomUUID() });
    this.agentRuns.start(key, { kind: "chat", chatId, mode: chat.mode },
      (signal) => this.loggedTurn((ownedSignal) => this.runGenerationTurn(chatId, context.branchId, turn, ownedSignal), signal, context),
      { kind: chat.mode, title: character?.name ?? chat.title });
    return this.agentRuns.subscribe(key, 0, subscriberSignal)!;
  }

  subscribeChatGeneration: ChatMessageRuntimeApi["subscribeChatGeneration"] =
    (chatId, after, signal) => this.agentRuns.subscribe(chatGenerationKey(chatId), after, signal);

  stopChatGeneration: ChatMessageRuntimeApi["stopChatGeneration"] =
    (chatId) => ({ stopped: this.agentRuns.stop(chatGenerationKey(chatId)) });

  /** Runtime composition may give the turn isolated branch/trace state. */
  protected runGenerationTurn(_chatId: string, _branchId: string, turn: ChatGenerationTurn, signal: AbortSignal) {
    return turn(signal);
  }

  private async *loggedTurn(turn: ChatGenerationTurn, signal: AbortSignal, context: ChatGenerationContext) {
    yield { event: "generation-context", data: JSON.stringify(context) };
    try {
      yield* turn(signal);
    } catch (error) {
      // Preserve the former route writer's exact provider/bind error payload,
      // now recorded even when no browser remains to observe the failure.
      const message = extractProviderErrorMessage(error);
      const category = classifyProviderError(error);
      const code = error instanceof DiceBindError || error instanceof ExperienceBindError ? error.code : undefined;
      logSendDebug("api.route.sse.error", { message, category, ...(code ? { code } : {}) });
      yield { event: "error", data: JSON.stringify({ message, category, ...(code ? { code } : {}) }) };
    }
  }
}

/** Namespaced against agent thread IDs and manual-summary job keys. */
function chatGenerationKey(chatId: string): string { return `chat:${chatId}`; }
