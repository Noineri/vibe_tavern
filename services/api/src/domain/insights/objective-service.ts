/**
 * Objective Tracker service (INSIGHTS_PLAN INS-3b + INS-3c).
 *
 * Owns the Objective Tracker state for a chat: generating a task route from the
 * conversation, checking whether the active task is complete and advancing,
 * and the task CRUD. The LLM calls go through `nonstreamingProviderExecute`,
 * injected (default = the real executor) so the full generate → parse → persist
 * and check → advance paths are unit-testable without `mock.module()` (per
 * AGENTS.md §1.4 — inject the dep, don't mock it globally).
 *
 * INS-3c — prompt assembly via the InsightsAssembler registry. The check/generate
 * prompt is built by `getInsightsAssembler("objective")` (a pure registry peer
 * to Summary / AI-assistant; see `docs/architecture/prompt-pipeline.md` §
 * Registries), NOT by a flag on `assemblePrompt`. The caller supplies the full
 * RP world context (character / persona / activated lorebook / script
 * injections / recent window, sliced per `contextWindow`, WITHOUT the
 * objectiveTask/sceneState injection fields); the assembler reuses the chat-turn
 * pipeline (`buildLayers`) so the objective model sees the same world the main
 * model sees — under the same preset toggles — minus only the insight
 * self-injection layers, plus the resolved instruction as the final user
 * message. The service resolves the instruction (override-or-default via
 * `insights-prompts.ts` → `.md` assets, also injected for testability) and
 * composes the dynamic context (objective description / active task). The
 * assembler returns a `PromptAssemblyResult`; this service maps it to the
 * `AssemblePromptResponse` the executor consumes.
 *
 * Status model (flat ordered task list — order is the route order):
 *  - 'pending'    → not started (the default after generate)
 *  - 'active'     → explicitly current (manual pick; the auto-flow uses pending)
 *  - 'completed'  → accomplished
 *  - 'abandoned'  → skipped
 * The active TARGET = first 'active', else first 'pending' (see selectActiveTask).
 * checkCompletion marks the current target 'completed'; the next pending then
 * becomes the implicit target.
 */
import type { AssemblePromptResponse, ChatBranchId, ChatId, ObjectiveState, ObjectiveTask, ObjectiveTaskStatus } from "@vibe-tavern/domain";
import { brandId, OBJECTIVE_TASK_STATUS } from "@vibe-tavern/domain";
import { z } from "zod";
import type { StoreContainer } from "@vibe-tavern/db";
import { getInsightsAssembler } from "@vibe-tavern/prompt-pipeline";
import type { PromptAssemblyContext, PromptAssemblyResult } from "@vibe-tavern/prompt-pipeline";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import type { ProviderExecutionInput } from "../../infrastructure/ai/provider-execution-types.js";
import { resolveInsightsPrompt } from "./insights-prompts.js";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import type { ProviderProfileService } from "../providers/provider-profile-service.js";
import { BackgroundTaskLocks } from "../../shared/background-task-locks.js";
import { logSendDebug } from "../../shared/send-debug-log.js";
import { parseStructuredOutput } from "./structured-output.js";

type Execute = typeof nonstreamingProviderExecute;
type ResolvePrompt = typeof resolveInsightsPrompt;
type ResolvedProfile = ProviderExecutionInput["profile"];

/** Default recent-message window for the Objective model. */
export const OBJECTIVE_CONTEXT_WINDOW = 10;

function isObjectiveEnabled(insightsConfig: Record<string, unknown>): boolean {
  return insightsConfig?.objectiveEnabled === true;
}

/** Default ObjectiveState for a chat that has none yet (or for addTask on an empty chat). */
export function defaultObjectiveState(): ObjectiveState {
  return {
    objectiveDescription: "",
    tasks: [],
    autoCheckFrequency: 0,
    contextWindow: OBJECTIVE_CONTEXT_WINDOW,
    injectionDepth: 1,
    generatePrompt: "",
    checkPrompt: "",
    injectPrompt: "",
    useChatModel: true,
    providerProfileId: null,
    model: null,
  };
}

const generatedTaskRouteSchema = z.object({
  tasks: z.array(z.object({ description: z.string().trim().min(1) }).strict()).min(1),
}).strict();

const completionVerdictSchema = z.object({ completed: z.boolean() }).strict();

const OBJECTIVE_TASK_STATUSES: readonly ObjectiveTaskStatus[] = [
  OBJECTIVE_TASK_STATUS.pending,
  OBJECTIVE_TASK_STATUS.active,
  OBJECTIVE_TASK_STATUS.completed,
  OBJECTIVE_TASK_STATUS.abandoned,
];

function isObjectiveTaskStatus(value: unknown): value is ObjectiveTaskStatus {
  return typeof value === "string" && OBJECTIVE_TASK_STATUSES.some((status) => status === value);
}

/** Parse the generation model's strict JSON route. All generated tasks start pending. */
export function parseTaskList(text: string): ObjectiveTask[] {
  const route = parseStructuredOutput(text, generatedTaskRouteSchema);
  return route.tasks.map((task, index) => ({
    id: `obj_task_${index + 1}`,
    description: task.description,
    status: OBJECTIVE_TASK_STATUS.pending,
  }));
}

/** Parse the completion model's strict `{ completed: boolean }` JSON verdict. */
export function parseCheckVerdict(text: string): boolean {
  return parseStructuredOutput(text, completionVerdictSchema).completed;
}

/** The active target = first 'active' task, else first 'pending'. Null when the route is exhausted. */
export function selectActiveTask(tasks: ObjectiveTask[]): ObjectiveTask | null {
  return (
    tasks.find((t) => t.status === OBJECTIVE_TASK_STATUS.active) ??
    tasks.find((t) => t.status === OBJECTIVE_TASK_STATUS.pending) ??
    null
  );
}

/**
 * Mark the current active target 'completed' (the check passed). Returns a new
 * array (no mutation). The next 'pending' implicitly becomes the target on the
 * next selectActiveTask call. No-op when there is no active target.
 */
export function advanceAfterCompletion(tasks: ObjectiveTask[]): ObjectiveTask[] {
  const target = selectActiveTask(tasks);
  if (!target) return tasks;
  return tasks.map((t) => (t.id === target.id ? { ...t, status: OBJECTIVE_TASK_STATUS.completed } : t));
}

/**
 * Map a pure pipeline `PromptAssemblyResult` (from the InsightsAssembler) to the
 * `AssemblePromptResponse` DTO the executor consumes. The insight prompt has no
 * lore activation, scripts, or retrieval — those trace fields stay empty. The
 * executor only reads `finalPayload.messages` (via `toSdkMessages`); the mapped
 * `layers` exist for trace/logging consistency.
 */
export function insightsAssemblyToPromptResponse(assembly: PromptAssemblyResult): AssemblePromptResponse {
  return {
    layers: assembly.layers.map((layer) => ({
      id: layer.id,
      sourceType: layer.sourceType,
      sourceId: layer.sourceId,
      sourceName: layer.sourceName,
      position: layer.position,
      priority: layer.priority,
      enabled: layer.enabled,
      reason: layer.reason,
      tokenCount: layer.tokenCount,
      text: layer.text,
      ...(layer.injectionDepth !== undefined ? { injectionDepth: layer.injectionDepth } : {}),
    })),
    tokenAccounting: { total: assembly.totalTokenEstimate },
    activatedLoreEntries: [],
    scriptInjections: [],
    retrievedMemories: [],
    finalPayload: assembly.finalPayload,
    prefill: assembly.prefill ?? null,
  };
}

/** Compose the final instruction: override-or-default base + dynamic objective context. */
function composeGenerateInstruction(base: string, objectiveDescription: string): string {
  return `${base}\n\nObjective: ${objectiveDescription.trim() || "(unspecified)"}\n\nRequired output: one JSON object shaped exactly as {"tasks":[{"description":"..."}]}.`;
}

function composeCheckInstruction(base: string, objectiveDescription: string, taskDescription: string): string {
  return `${base}\n\nObjective: ${objectiveDescription.trim() || "(unspecified)"}\nActive task: ${taskDescription}\n\nRequired output: one JSON object shaped exactly as {"completed":true} or {"completed":false}.`;
}

/**
 * Normalize a raw stored value into a complete ObjectiveState, filling any
 * missing field with its default. This is the backward-compat migration path:
 * chats created before the model-selection fields (useChatModel/
 * providerProfileId/model) — or stored as `{}` — load with `useChatModel: true`
 * (the chat's active provider + default model), so auto-check keeps working
 * without a DB migration. Mirrors {@link normalizeAutoSummaryConfig}.
 */
function normalizeObjectiveState(raw: unknown): ObjectiveState {
  const base = defaultObjectiveState();
  if (typeof raw !== "object" || raw === null) return base;
  const r = raw as Partial<ObjectiveState>;
  const tasks: ObjectiveTask[] = [];
  let activeSeen = false;
  if (Array.isArray(r.tasks)) {
    for (const candidate of r.tasks as unknown[]) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const task = candidate as Partial<ObjectiveTask>;
      const id = typeof task.id === "string" ? task.id.trim() : "";
      const description = typeof task.description === "string" ? task.description.trim() : "";
      if (!id || !description || !isObjectiveTaskStatus(task.status)) continue;
      const status = task.status === OBJECTIVE_TASK_STATUS.active && activeSeen
        ? OBJECTIVE_TASK_STATUS.pending
        : task.status;
      if (status === OBJECTIVE_TASK_STATUS.active) activeSeen = true;
      tasks.push({ id, description, status });
    }
  }
  return {
    objectiveDescription: typeof r.objectiveDescription === "string" ? r.objectiveDescription : base.objectiveDescription,
    tasks,
    autoCheckFrequency: typeof r.autoCheckFrequency === "number" && Number.isFinite(r.autoCheckFrequency)
      ? Math.max(0, Math.floor(r.autoCheckFrequency))
      : base.autoCheckFrequency,
    contextWindow: typeof r.contextWindow === "number" && Number.isFinite(r.contextWindow)
      ? Math.max(1, Math.floor(r.contextWindow))
      : base.contextWindow,
    injectionDepth: typeof r.injectionDepth === "number" && Number.isFinite(r.injectionDepth)
      ? Math.max(1, Math.floor(r.injectionDepth))
      : base.injectionDepth,
    generatePrompt: typeof r.generatePrompt === "string" ? r.generatePrompt : base.generatePrompt,
    checkPrompt: typeof r.checkPrompt === "string" ? r.checkPrompt : base.checkPrompt,
    injectPrompt: typeof r.injectPrompt === "string" ? r.injectPrompt : base.injectPrompt,
    useChatModel: typeof r.useChatModel === "boolean" ? r.useChatModel : base.useChatModel,
    providerProfileId: typeof r.providerProfileId === "string" && r.providerProfileId.trim() ? r.providerProfileId : base.providerProfileId,
    model: typeof r.model === "string" && r.model.trim() ? r.model : base.model,
  };
}

export interface ObjectiveGenerateInput {
  chatId: ChatId;
  profile: ResolvedProfile;
  model: string;
  /**
   * The full RP world context (character / persona / activated lorebook /
   * script injections / recent window sliced per `contextWindow`), WITHOUT the
   * `objectiveTask`/`sceneState` injection fields. Built by the caller
   * (prompt-assembly-service in INS-4) the same way a chat turn is, so the
   * objective model sees the same world the main model sees.
   */
  context: PromptAssemblyContext;
  signal?: AbortSignal;
}

export interface ObjectiveCheckInput extends ObjectiveGenerateInput {}

export interface ObjectiveAutoCheckTrigger {
  chatId: string;
  branchId: string;
  messageId: string;
}

function routeRevision(state: ObjectiveState): string {
  return JSON.stringify({ objectiveDescription: state.objectiveDescription, tasks: state.tasks });
}

/** Small FIFO keyed coordinator used for independent LLM and commit lanes. */
class ObjectiveKeyedCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(chatId: ChatId, task: () => Promise<T>): Promise<T> {
    const key = chatId as string;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => slot);
    this.tails.set(key, tail);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release?.();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export class ObjectiveService {
  /** Chat-keyed trailing lock for auto-check. A trigger dropped mid-flight
   *  replaces `latestAutoTrigger`; the owner re-runs against that event's exact
   *  branch before releasing. See BackgroundTaskLocks.runExclusiveTrailing. */
  private readonly autoCheckLocks = new BackgroundTaskLocks();
  private readonly latestAutoTrigger = new Map<string, ObjectiveAutoCheckTrigger>();
  /** Long lane: generate/check LLM work is serialized per chat. */
  private readonly llmCoordinator = new ObjectiveKeyedCoordinator();
  /** Short lane: every Objective read-modify-write commit is atomic per chat. */
  private readonly stateCoordinator = new ObjectiveKeyedCoordinator();

  constructor(
    private readonly stores: StoreContainer,
    private readonly sessionRuntime: SessionRuntime,
    private readonly providerProfiles: ProviderProfileService,
    private readonly execute: Execute = nonstreamingProviderExecute,
    private readonly resolvePrompt: ResolvePrompt = resolveInsightsPrompt,
  ) {}

  /** Load the chat's objective state, or null when none has been generated. */
  async getState(chatId: ChatId): Promise<ObjectiveState> {
    const chat = await this.stores.chats.getById(chatId);
    if (!chat) return defaultObjectiveState();
    return normalizeObjectiveState(chat.insightsObjectiveState);
  }

  /** The current active task (first 'active', else first 'pending'), or null. */
  async getActiveTask(chatId: ChatId): Promise<ObjectiveTask | null> {
    const state = await this.getState(chatId);
    return state ? selectActiveTask(state.tasks) : null;
  }

  /**
   * Generate a task route from the conversation. Preserves the existing config
   * (prompts, depth, frequency) and objective description; replaces the task
   * list. Throws on an empty generation (the LLM produced no parseable tasks).
   */
  async generateTasks(input: ObjectiveGenerateInput): Promise<ObjectiveState> {
    return this.llmCoordinator.run(input.chatId, async () => {
      input.signal?.throwIfAborted();
      const state = await this.getState(input.chatId);
      const revision = routeRevision(state);
      const instructionBase = await this.resolvePrompt("objectiveGenerate", state.generatePrompt);
      const instruction = composeGenerateInstruction(instructionBase, state.objectiveDescription);
      const prompt = this.buildPrompt(input.context, instruction);
      const result = await this.execute({ profile: input.profile, model: input.model, prompt, signal: input.signal });
      input.signal?.throwIfAborted();
      const tasks = parseTaskList(result.text);
      if (tasks.length === 0) {
        throw new Error("Objective generation produced no tasks — try adjusting the objective description or the generate prompt.");
      }

      // CRUD/config remain responsive during the LLM await. Re-read and merge
      // only the generated route; if the user edited the route/goal itself,
      // discard this stale generation rather than overwriting their intent.
      return this.commitState(input.chatId, (current) => {
        if (routeRevision(current) !== revision) return null;
        return { ...current, tasks };
      }, input.signal);
    });
  }

  /**
   * Ask the LLM whether the current active task is complete; if so, mark it
   * 'completed' (advancing the route). No-op when there is no active task or the
   * LLM says PENDING. Returns the (possibly updated) state.
   */
  async checkCompletion(input: ObjectiveCheckInput): Promise<ObjectiveState> {
    return this.llmCoordinator.run(input.chatId, async () => {
      input.signal?.throwIfAborted();
      const state = await this.getState(input.chatId);
      const target = selectActiveTask(state.tasks);
      if (!target) return state;
      const instructionBase = await this.resolvePrompt("objectiveCheck", state.checkPrompt);
      const instruction = composeCheckInstruction(instructionBase, state.objectiveDescription, target.description);
      const prompt = this.buildPrompt(input.context, instruction);
      const result = await this.execute({ profile: input.profile, model: input.model, prompt, signal: input.signal });
      input.signal?.throwIfAborted();
      const completed = parseCheckVerdict(result.text);
      if (!completed) return this.getState(input.chatId);

      return this.commitState(input.chatId, (current) => {
        // The verdict belongs to one immutable target. A route edit/reorder/status
        // change during the await invalidates it; never advance a replacement.
        const currentTarget = selectActiveTask(current.tasks);
        const matchingTask = current.tasks.find((task) => task.id === target.id);
        if (
          currentTarget?.id !== target.id ||
          !matchingTask ||
          matchingTask.description !== target.description ||
          matchingTask.status !== target.status
        ) {
          return null;
        }
        return { ...current, tasks: advanceAfterCompletion(current.tasks) };
      }, input.signal);
    });
  }

  /** Build the insight one-shot prompt (RP world context + instruction) via the assembler registry. */
  private buildPrompt(context: PromptAssemblyContext, instruction: string): AssemblePromptResponse {
    const assembly = getInsightsAssembler("objective").assemble(context, instruction);
    return insightsAssemblyToPromptResponse(assembly);
  }

  /** Append a new 'pending' task to the route (creating state if none exists). */
  async addTask(chatId: ChatId, description: string): Promise<ObjectiveState> {
    const normalizedDescription = description.trim();
    if (!normalizedDescription) throw new Error("Objective task description is required.");
    return this.commitState(chatId, (base) => {
      const task: ObjectiveTask = {
        id: `obj_task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        description: normalizedDescription,
        status: OBJECTIVE_TASK_STATUS.pending,
      };
      return { ...base, tasks: [...base.tasks, task] };
    });
  }

  /** Patch a task (description and/or status). Throws if the task id is unknown. */
  async updateTask(chatId: ChatId, taskId: string, patch: Partial<Pick<ObjectiveTask, "description" | "status">>): Promise<ObjectiveState> {
    const description = patch.description?.trim();
    if (patch.description !== undefined && !description) throw new Error("Objective task description is required.");
    if (patch.status !== undefined && !isObjectiveTaskStatus(patch.status)) {
      throw new Error(`Unknown objective task status: '${String(patch.status)}'.`);
    }
    return this.commitState(chatId, (base) => {
      let found = false;
      const tasks = base.tasks.map((task) => {
        if (task.id === taskId) {
          found = true;
          return {
            ...task,
            ...(description !== undefined ? { description } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
          };
        }
        if (patch.status === OBJECTIVE_TASK_STATUS.active && task.status === OBJECTIVE_TASK_STATUS.active) {
          return { ...task, status: OBJECTIVE_TASK_STATUS.pending };
        }
        return task;
      });
      if (!found) throw new Error(`Objective task '${taskId}' not found in chat '${chatId}'.`);
      return { ...base, tasks };
    });
  }

  /** Reorder the route. The supplied ids must be one complete permutation. */
  async reorderTasks(chatId: ChatId, taskIds: string[]): Promise<ObjectiveState> {
    return this.commitState(chatId, (base) => {
      const uniqueIds = new Set(taskIds);
      const taskById = new Map(base.tasks.map((task) => [task.id, task]));
      if (taskIds.length !== base.tasks.length || uniqueIds.size !== base.tasks.length || taskIds.some((id) => !taskById.has(id))) {
        throw new Error("Objective task order must be a complete permutation of the current route.");
      }
      const tasks = taskIds.map((id) => taskById.get(id));
      if (tasks.some((task) => task === undefined)) {
        throw new Error("Objective task order must be a complete permutation of the current route.");
      }
      return { ...base, tasks: tasks.filter((task): task is ObjectiveTask => task !== undefined) };
    });
  }

  /** Remove a task from the route. Throws if the task id is unknown. */
  async deleteTask(chatId: ChatId, taskId: string): Promise<ObjectiveState> {
    return this.commitState(chatId, (base) => {
      if (!base.tasks.some((task) => task.id === taskId)) {
        throw new Error(`Objective task '${taskId}' not found in chat '${chatId}'.`);
      }
      return { ...base, tasks: base.tasks.filter((task) => task.id !== taskId) };
    });
  }

  /** Set/replace the objective description (the high-level goal). */
  async setObjectiveDescription(chatId: ChatId, objectiveDescription: string): Promise<ObjectiveState> {
    const normalizedDescription = objectiveDescription.trim();
    if (!normalizedDescription) throw new Error("Objective description is required.");
    return this.commitState(chatId, (base) => ({ ...base, objectiveDescription: normalizedDescription }));
  }

  /**
   * INS-5 — update the non-task objective config (tuning + custom prompts). All
   * fields optional; only present keys are merged. autoCheckFrequency is clamped
   * to >= 0 (0 = manual only), injectionDepth to >= 1. The custom prompts are
   * empty by default → the insights-prompts loader falls back to the `.md`
   * asset; setting a non-empty value here overrides it per-chat.
   */
  async updateObjectiveConfig(
    chatId: ChatId,
    patch: Partial<Pick<ObjectiveState, "autoCheckFrequency" | "contextWindow" | "injectionDepth" | "generatePrompt" | "checkPrompt" | "injectPrompt" | "useChatModel" | "providerProfileId" | "model">>,
  ): Promise<ObjectiveState> {
    return this.commitState(chatId, (base) => {
      const next: ObjectiveState = { ...base };
      if (patch.autoCheckFrequency !== undefined) {
        const n = Math.floor(patch.autoCheckFrequency);
        next.autoCheckFrequency = Number.isFinite(n) && n >= 0 ? n : 0;
      }
      if (patch.contextWindow !== undefined) {
        const n = Math.floor(patch.contextWindow);
        next.contextWindow = Number.isFinite(n) && n >= 1 ? n : OBJECTIVE_CONTEXT_WINDOW;
      }
      if (patch.injectionDepth !== undefined) {
        const d = Math.floor(patch.injectionDepth);
        next.injectionDepth = Number.isFinite(d) && d >= 1 ? d : 1;
      }
      if (patch.generatePrompt !== undefined) next.generatePrompt = patch.generatePrompt;
      if (patch.checkPrompt !== undefined) next.checkPrompt = patch.checkPrompt;
      if (patch.injectPrompt !== undefined) next.injectPrompt = patch.injectPrompt;
      if (patch.useChatModel !== undefined) next.useChatModel = patch.useChatModel;
      if (patch.providerProfileId !== undefined) next.providerProfileId = patch.providerProfileId?.trim() || null;
      if (patch.model !== undefined) next.model = patch.model?.trim() || null;
      return next;
    });
  }

  /**
   * INS-4 — auto-check entry point fired by the Insights FeatureModule on each
   * `message.appended` (send/generate only — the swipe/regenerate path does not
   * emit it). Gates on objectiveEnabled + autoCheckFrequency, then runs
   * {@link checkCompletion} under the trailing-edge lock so a burst of messages
   * never leaves the latest unevaluated. Each invocation consumes the latest
   * immutable `{ chatId, branchId, messageId }` event and re-reads state/context
   * for that branch (trailing re-run correctness). Provider/model resolution
   * comes from the stored per-insight config (use chat model or the separately
   * pinned profile/model), mirroring auto-summary. Fire-and-forget — the EventBus
   * caller never waits on or sees errors from this path (they go to logSendDebug).
   */
  async triggerAutoCheck(trigger: ObjectiveAutoCheckTrigger): Promise<void> {
    const lockKey = trigger.chatId;
    this.latestAutoTrigger.set(lockKey, trigger);
    const ran = await this.autoCheckLocks.runExclusiveTrailing(
      lockKey,
      async () => {
        // Trailing runs consume the latest immutable event identity, not the
        // first closure's branch. Every read and context build targets it.
        const latest = this.latestAutoTrigger.get(lockKey);
        if (!latest) return;
        const chat = await this.stores.chats.getById(latest.chatId);
        if (!chat || !isObjectiveEnabled(chat.insightsConfig)) return;
        const chatId = chat.id as ChatId;
        const branchId = brandId<ChatBranchId>(latest.branchId);
        const state = await this.getState(chatId);
        if (state.autoCheckFrequency <= 0) return;
        const messages = await this.stores.messages.getMessages(branchId);
        const assistantCount = messages.filter((message) => message.role === "assistant").length;
        if (assistantCount === 0 || assistantCount % state.autoCheckFrequency !== 0) return;

        const resolved = await this.resolveInsightProvider(state);
        if (!resolved) {
          logSendDebug("insights.objective.auto.skip", { chatId: chat.id, messageId: latest.messageId, reason: state.useChatModel ? "no_provider" : "no_provider_or_model" });
          return;
        }
        const { profile, model } = resolved;
        const built = await this.sessionRuntime.chatLifecycle.buildPipelineContext({
          chatId,
          branchId,
          model,
          recentMessageLimit: state.contextWindow,
        });
        await this.checkCompletion({ chatId, profile, model, context: built.context });
      },
      (err) => {
        const failedTrigger = this.latestAutoTrigger.get(lockKey) ?? trigger;
        logSendDebug("insights.objective.auto.error", {
          chatId: failedTrigger.chatId,
          messageId: failedTrigger.messageId,
          message: err instanceof Error ? err.message : String(err),
        });
      },
    );
    // The lock owner has consumed every dirty trailing trigger before `ran`
    // resolves. Dropped callers return `false`, so only the owner cleans up.
    if (ran) this.latestAutoTrigger.delete(lockKey);
  }

  /**
   * Serialize the short read-modify-write commit for every Objective mutation.
   * Returning null discards a stale LLM result without writing. CRUD/config can
   * run while an LLM is in flight; they only serialize against this final DB
   * commit, closing the fresh-read → whole-JSON-save lost-update window.
   */
  private async commitState(
    chatId: ChatId,
    mutate: (current: ObjectiveState) => ObjectiveState | null,
    signal?: AbortSignal,
  ): Promise<ObjectiveState> {
    return this.stateCoordinator.run(chatId, async () => {
      signal?.throwIfAborted();
      const current = await this.getState(chatId);
      const next = mutate(current);
      if (!next) return current;
      signal?.throwIfAborted();
      await this.stores.chats.updateInsightsObjectiveState(chatId, {
        insightsObjectiveState: next as unknown as Record<string, unknown>,
      });
      return next;
    });
  }

  /**
   * Resolve the insight (generate/check) provider + model from the stored
   * ObjectiveState config — mirrors {@link ChatSummaryService.triggerAutoSummary}'s
   * resolution: `useChatModel` → the chat's active profile + default model;
   * otherwise the pinned `providerProfileId` + optional secondary model override.
   * The secondary pin is preserved but ignored while chat-model mode is on.
   * Returns null when no usable profile/model is configured (caller skips).
   */
  async resolveInsightProvider(
    state: ObjectiveState,
  ): Promise<{ profile: NonNullable<Awaited<ReturnType<ProviderProfileService["resolveActiveProviderProfile"]>>>; model: string } | null> {
    const profile = state.useChatModel
      ? await this.providerProfiles.resolveActiveProviderProfile()
      : (state.providerProfileId ? await this.providerProfiles.getProviderProfile(state.providerProfileId) : null);
    if (!profile?.id) return null;
    // "Use chat model" means the active profile AND its chat/default model;
    // a secondary pin is preserved in state for toggling back, but must not
    // silently override the chat model while this mode is enabled.
    const model = state.useChatModel
      ? profile.defaultModel?.trim()
      : (state.model?.trim() || profile.defaultModel?.trim());
    if (!model) return null;
    return { profile: profile as NonNullable<Awaited<ReturnType<ProviderProfileService["resolveActiveProviderProfile"]>>>, model };
  }
}
