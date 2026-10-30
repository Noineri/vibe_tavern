import type { ChatGenerationJobRecord, StoreContainer } from "@vibe-tavern/db";
import { isRecord, log, type AgentRunOwner, type EventBus } from "@vibe-tavern/domain";
import { AgentRunActiveError, type AgentRunRegistry } from "../agent/agent-run-registry.js";
import { notFound, validation } from "../../shared/errors.js";

type Frame = { event: string; data: string };
type Turn = (signal: AbortSignal) => AsyncIterable<Frame>;
type Job = ChatGenerationJobRecord;
interface QueueDeps {
  stores: Pick<StoreContainer, "chats" | "messages" | "chatGenerationJobs">;
  registry: AgentRunRegistry<AgentRunOwner>;
  start: (job: Job, branchId: string, turn: Turn) => Promise<AsyncIterable<Frame>>;
  regenerate: (job: Job, signal: AbortSignal) => AsyncIterable<Frame>;
}
const logger = log.tag("chat.queue");
const interrupted = "Server restarted during generation. Retry this job to generate another variant.";

/** The only queue executor. Reuses the chat registry, regenerate producer and
 * per-chat notification channel; no HTTP/request or browser state is retained. */
export class ChatGenerationQueue {
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private readonly stopRequests = new Set<string>();
  private readonly executing = new Map<string, string>();
  private events?: EventBus;
  private unsubscribe?: () => void;
  private enabled = true;

  constructor(private readonly deps: QueueDeps) {}

  /** Called once at real server startup, after lifecycle subscribers exist.
   * Returns after recovery, not after pending model calls have completed. */
  async activate(events: EventBus): Promise<void> {
    if (this.unsubscribe) return;
    this.enabled = true;
    this.events = events;
    this.unsubscribe = this.deps.registry.onLifecycle((event) => {
      if (event.owner.kind === "chat" && "mode" in event.owner && event.state !== "started") this.schedule(event.owner.chatId);
    });
    const ids = await this.deps.stores.chatGenerationJobs.unfinishedChatIds();
    for (const chatId of ids) {
      for (const job of await this.list(chatId)) if (job.status === "running") {
        await this.deps.stores.chatGenerationJobs.setStatus(chatId, job.id, { status: "failed", error: interrupted }, "running");
        this.changed(chatId);
      }
      this.schedule(chatId);
    }
  }

  deactivate(): void { this.enabled = false; this.unsubscribe?.(); this.unsubscribe = undefined; }

  async list(chatId: string): Promise<Job[]> {
    if (!await this.deps.stores.chats.getById(chatId)) throw notFound("Chat");
    return this.deps.stores.chatGenerationJobs.listByChat(chatId);
  }

  async enqueue(chatId: string, input: Pick<Job, "messageId" | "model" | "promptPresetId">): Promise<Job> {
    await this.list(chatId);
    const target = await this.deps.stores.messages.getMessageById(input.messageId);
    if (!target || target.chatId !== chatId) throw notFound("Message");
    if (target.role !== "assistant") throw validation("Only assistant messages can be regenerated.");
    const job = await this.deps.stores.chatGenerationJobs.enqueue({ ...input, chatId });
    this.changed(chatId);
    this.schedule(chatId);
    return job;
  }

  async cancel(chatId: string, jobId: string): Promise<{ ok: true }> {
    await this.list(chatId);
    const jobs = this.deps.stores.chatGenerationJobs;
    const job = await jobs.get(chatId, jobId);
    if (!job) throw notFound("Queue job");
    if (job.status === "pending") {
      if (await jobs.cancelPending(chatId, jobId)) this.changed(chatId);
      // A claim can win while the cancellation awaits: stop only THIS job.
      else if ((await jobs.get(chatId, jobId))?.status === "running") this.stopJob(chatId, jobId);
    } else if (job.status === "running") this.stopJob(chatId, jobId);
    return { ok: true };
  }

  async clear(chatId: string): Promise<{ ok: true }> {
    await this.list(chatId);
    if (await this.deps.stores.chatGenerationJobs.clearPending(chatId)) this.changed(chatId);
    return { ok: true };
  }

  /** Also a deterministic join seam for tests; every scheduled rejection is
   * observed. Dirty wakes avoid losing idle/enqueue signals during an await. */
  kick(chatId: string): Promise<void> {
    this.dirty.add(chatId);
    const existing = this.lanes.get(chatId);
    if (existing) return existing;
    const lane = Promise.resolve().then(async () => {
      do { this.dirty.delete(chatId); await this.pump(chatId); } while (this.enabled && this.dirty.has(chatId));
    }).finally(() => { this.lanes.delete(chatId); });
    this.lanes.set(chatId, lane);
    return lane;
  }

  private schedule(chatId: string): void { void this.kick(chatId).catch((error: unknown) => logger.error("Queue runner failed", error)); }
  private changed(chatId: string): void { this.events?.emit("chat.notification", { chatId, kind: "queue.updated" }); }
  private busy(chatId: string): boolean { return this.deps.registry.active().some((run) => run.threadId === `chat:${chatId}`); }
  private stopJob(chatId: string, jobId: string): void {
    this.stopRequests.add(jobId);
    if (this.executing.get(chatId) === jobId) this.deps.registry.stop(`chat:${chatId}`);
  }

  private async pump(chatId: string): Promise<void> {
    const jobs = this.deps.stores.chatGenerationJobs;
    while (this.enabled && !this.busy(chatId)) {
      const job = await jobs.nextPending(chatId);
      if (!job || this.busy(chatId)) return;
      if (!await jobs.setStatus(chatId, job.id, { status: "running" }, "pending")) continue;
      this.changed(chatId);
      try {
        const target = await this.deps.stores.messages.getMessageById(job.messageId);
        if (!target || target.chatId !== chatId || target.role !== "assistant") throw new Error("Queue target no longer exists.");
        const stream = await this.deps.start(job, target.branchId, (signal) => this.runJob(job, signal));
        for await (const _frame of stream) { /* Registry owns execution; join finalization before advancing. */ }
      } catch (error) {
        if (error instanceof AgentRunActiveError) {
          await jobs.setStatus(chatId, job.id, { status: this.stopRequests.has(job.id) ? "cancelled" : "pending" }, "running");
          this.changed(chatId);
          return; // A competing ordinary generation won; its idle event wakes us.
        }
        if (await jobs.setStatus(chatId, job.id, { status: "failed", error: error instanceof Error ? error.message : String(error) }, "running")) this.changed(chatId);
      } finally {
        this.executing.delete(chatId);
        this.stopRequests.delete(job.id);
      }
    }
  }

  private async *runJob(job: Job, signal: AbortSignal): AsyncGenerator<Frame> {
    this.executing.set(job.chatId, job.id);
    const before = new Set((await this.deps.stores.messages.getVariants(job.messageId)).map((variant) => variant.id));
    let finished = false;
    let stopped = false;
    let error: string | undefined;
    try {
      if (this.stopRequests.has(job.id)) {
        this.deps.registry.stop(`chat:${job.chatId}`);
        stopped = true;
        yield { event: "abort", data: '{"partialLength":0}' };
        return;
      }
      for await (const frame of this.deps.regenerate(job, signal)) {
        if (frame.event === "abort") stopped = true;
        if (frame.event === "error" || frame.event === "finish") {
          const payload: unknown = JSON.parse(frame.data);
          if (isRecord(payload)) {
            if (frame.event === "error") error = typeof payload.message === "string" ? payload.message : "Generation failed.";
            else if (payload.finishReason === "error") error = "Provider ended generation with an error.";
            else finished = true;
          }
        }
        yield frame;
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      throw failure;
    } finally {
      const variant = (await this.deps.stores.messages.getVariants(job.messageId)).find((item) => !before.has(item.id));
      const status = signal.aborted || stopped ? "cancelled" : error || !finished || !variant ? "failed" : "done";
      await this.deps.stores.chatGenerationJobs.setStatus(job.chatId, job.id, {
        status, variantIndex: variant?.variantIndex,
        error: status === "failed" ? error ?? "Generation ended without a saved variant. Retry this job." : null,
      }, "running");
      // Settled BEFORE registry publishes finished/stopped/failed (toast sees
      // canonical queue state), but AFTER partial/final variant persistence.
      this.changed(job.chatId);
    }
  }
}
