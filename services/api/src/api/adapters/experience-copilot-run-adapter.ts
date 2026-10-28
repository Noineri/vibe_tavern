/** BR-1b: the server-owned run lifecycle and the extracted raw kind dispatcher. */
import type { ExperienceCopilotStore } from "@vibe-tavern/db";
import type { AgentThreadOwner } from "@vibe-tavern/domain";
import type { ExperienceCopilotRuntimeApi } from "../contract/experience-copilot-contracts.js";
import { AgentRunRegistry } from "../../domain/agent/agent-run-registry.js";
import { notFound } from "../../shared/errors.js";
import { extractProviderErrorMessage } from "../../infrastructure/ai/provider-error-message.js";
import { classifyProviderError } from "../../infrastructure/ai/provider-error-classifier.js";
import { logSendDebug } from "../../shared/send-debug-log.js";

export type CopilotRunOwner = AgentThreadOwner | { kind: "draft"; draftSessionId: string | null };
type KindStream = ExperienceCopilotRuntimeApi["experienceCopilotStream"];

export class ExperienceCopilotRunAdapter {
  /** One instance per server adapter, shared by every request and agent kind. */
  readonly agentRuns = new AgentRunRegistry<CopilotRunOwner>();

  constructor(
    private readonly runStore: Pick<ExperienceCopilotStore, "getById">,
    private readonly resolveRunStream: (threadId: string) => Promise<KindStream>,
  ) {}

  /** AS-8b kind dispatch: the thread resolves to its agent kind through the
   * ONE resolveThreadKind and runs THAT kind's streamKinds table entry.
   * A resolved kind without an entry throws AgentKindNotWiredError. Raw
   * domain callers retain the original generator and cancellation contract. */
  experienceCopilotStream: KindStream = async function* (
    this: ExperienceCopilotRunAdapter, threadId, body, signal,
  ) {
    const stream = await this.resolveRunStream(threadId);
    yield* stream(threadId, body, signal);
  };

  experienceCopilotStartRun: ExperienceCopilotRuntimeApi["experienceCopilotStartRun"] = async (threadId, body, subscriberSignal) => {
    // Resolve BEFORE reserving/streaming: kind failures remain HTTP errors.
    const stream = await this.resolveRunStream(threadId);
    const thread = await this.runStore.getById(threadId);
    if (!thread) throw notFound("ExperienceCopilotThread", `Copilot thread '${threadId}' was not found.`);
    const owner: CopilotRunOwner = thread.chatId !== null && thread.branchId !== null && thread.agentKind !== null
      ? { kind: "chat", chatId: thread.chatId, branchId: thread.branchId, agentKind: thread.agentKind }
      : thread.scriptId !== null
        ? { kind: "script", scriptId: thread.scriptId }
        : { kind: "draft", draftSessionId: thread.draftSessionId };
    this.agentRuns.start(threadId, owner, (signal) => this.loggedTurn(stream, threadId, body, signal));
    // Bind synchronously to THIS run, before a later start can replace its log.
    return this.agentRuns.subscribe(threadId, 0, subscriberSignal)!;
  };

  experienceCopilotSubscribeRun: ExperienceCopilotRuntimeApi["experienceCopilotSubscribeRun"] =
    (threadId, after, signal) => this.agentRuns.subscribe(threadId, after, signal);

  experienceCopilotStopRun: ExperienceCopilotRuntimeApi["experienceCopilotStopRun"] =
    (threadId) => ({ stopped: this.agentRuns.stop(threadId) });

  private async *loggedTurn(
    stream: KindStream, threadId: string, body: Parameters<KindStream>[1], signal: AbortSignal,
  ) {
    try {
      yield* stream(threadId, body, signal);
    } catch (err) {
      // The old SSE writer classified thrown turn errors. Do it before the
      // registry now, so even an unwatched failure is numbered and replayable.
      const message = extractProviderErrorMessage(err);
      const category = classifyProviderError(err);
      logSendDebug("api.route.copilot-sse.error", { message, category });
      yield { event: "error", data: JSON.stringify({ message, category }) };
    }
  }
}
