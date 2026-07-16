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
import type { AssemblePromptResponse, ChatBranchId, ChatId, ObjectiveLongTermGoal, ObjectiveMode, ObjectiveShortTermGoal, ObjectiveState, ObjectiveTask, ObjectiveTaskStatus } from "@vibe-tavern/domain";
import { brandId, OBJECTIVE_MODE, OBJECTIVE_TASK_STATUS } from "@vibe-tavern/domain";
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
    mode: OBJECTIVE_MODE.route,
    objectiveDescription: "",
    tasks: [],
    longTermGoal: null,
    shortTermGoals: [],
    autoCheckFrequency: 0,
    autoCheckEventCount: 0,
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

const generatedGoalsSchema = z.object({
  longTerm: z.object({ description: z.string().trim().min(1) }).strict(),
  shortTerm: z.array(z.object({ description: z.string().trim().min(1) }).strict()).min(1),
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

/** Parse the goals-mode generation: one long-term goal + a non-empty short-term list. All start pending. */
export function parseGoalsResult(text: string): {
  longTermGoal: ObjectiveLongTermGoal;
  shortTermGoals: ObjectiveShortTermGoal[];
} {
  const parsed = parseStructuredOutput(text, generatedGoalsSchema);
  return {
    longTermGoal: { description: parsed.longTerm.description, status: OBJECTIVE_TASK_STATUS.pending },
    shortTermGoals: parsed.shortTerm.map((goal, index) => ({
      id: `obj_st_${index + 1}`,
      description: goal.description,
      status: OBJECTIVE_TASK_STATUS.pending,
    })),
  };
}

/** Parse the completion model's strict `{ completed: boolean }` JSON verdict. */
export function parseCheckVerdict(text: string): boolean {
  return parseStructuredOutput(text, completionVerdictSchema).completed;
}

/**
 * The active target = first 'active' item, else first 'pending'. Null when the
 * route/list is exhausted. Generic over the task/goal shape (ObjectiveTask and
 * ObjectiveShortTermGoal share it) so route tasks and goals-mode short-term
 * goals reuse the same invariant.
 */
export function selectActiveTask<T extends ObjectiveTask = ObjectiveTask>(items: T[]): T | null {
  return (
    items.find((t) => t.status === OBJECTIVE_TASK_STATUS.active) ??
    items.find((t) => t.status === OBJECTIVE_TASK_STATUS.pending) ??
    null
  );
}

/**
 * Mark the current active target 'completed' (the check passed). Returns a new
 * array (no mutation). The next 'pending' implicitly becomes the target on the
 * next selectActiveTask call. No-op when there is no active target.
 */
export function advanceAfterCompletion<T extends ObjectiveTask = ObjectiveTask>(items: T[]): T[] {
  const target = selectActiveTask(items);
  if (!target) return items;
  return items.map((t) => (t.id === target.id ? { ...t, status: OBJECTIVE_TASK_STATUS.completed } : t));
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

function composeGenerateGoalsInstruction(base: string): string {
  return `${base}\n\nRequired output: one JSON object shaped exactly as {"longTerm":{"description":"..."},"shortTerm":[{"description":"..."}]}.`;
}

function composeCheckGoalsInstruction(base: string, longTermDescription: string | null, shortTermDescription: string): string {
  const longTermLine = longTermDescription?.trim() ? `Long-term goal: ${longTermDescription.trim()}\n` : "";
  return `${base}\n\n${longTermLine}Active short-term goal: ${shortTermDescription}\n\nRequired output: one JSON object shaped exactly as {"completed":true} or {"completed":false}.`;
}

/**
 * Normalize a raw stored array of `{id,description,status}` items — route tasks OR
 * goals-mode short-term goals — collapsing to at most one `active` (the rest that
 * claim `active` fall back to `pending`). Shared by both modes since the item
 * shape is identical; the caller assigns the result to the typed field.
 */
function normalizeObjectiveItems(raw: unknown): { id: string; description: string; status: ObjectiveTaskStatus }[] {
  const items: { id: string; description: string; status: ObjectiveTaskStatus }[] = [];
  let activeSeen = false;
  if (Array.isArray(raw)) {
    for (const candidate of raw as unknown[]) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const item = candidate as Partial<ObjectiveTask>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const description = typeof item.description === "string" ? item.description.trim() : "";
      if (!id || !description || !isObjectiveTaskStatus(item.status)) continue;
      const status = item.status === OBJECTIVE_TASK_STATUS.active && activeSeen
        ? OBJECTIVE_TASK_STATUS.pending
        : item.status;
      if (status === OBJECTIVE_TASK_STATUS.active) activeSeen = true;
      items.push({ id, description, status });
    }
  }
  return items;
}

/** Normalize a raw stored long-term goal. Returns null when malformed/absent. */
function normalizeLongTermGoal(raw: unknown): ObjectiveLongTermGoal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const goal = raw as Partial<ObjectiveLongTermGoal>;
  const description = typeof goal.description === "string" ? goal.description.trim() : "";
  if (!description || !isObjectiveTaskStatus(goal.status)) return null;
  return { description, status: goal.status };
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
  const tasks = normalizeObjectiveItems(r.tasks);
  return {
    mode: r.mode === OBJECTIVE_MODE.goals ? OBJECTIVE_MODE.goals : OBJECTIVE_MODE.route,
    objectiveDescription: typeof r.objectiveDescription === "string" ? r.objectiveDescription : base.objectiveDescription,
    tasks,
    longTermGoal: normalizeLongTermGoal(r.longTermGoal),
    shortTermGoals: normalizeObjectiveItems(r.shortTermGoals),
    autoCheckFrequency: typeof r.autoCheckFrequency === "number" && Number.isFinite(r.autoCheckFrequency)
      ? Math.max(0, Math.floor(r.autoCheckFrequency))
      : base.autoCheckFrequency,
    autoCheckEventCount: typeof r.autoCheckEventCount === "number" && Number.isFinite(r.autoCheckEventCount)
      ? Math.max(0, Math.floor(r.autoCheckEventCount))
      : base.autoCheckEventCount,
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

function goalsRevision(state: ObjectiveState): string {
  return JSON.stringify({ mode: state.mode, longTermGoal: state.longTermGoal, shortTermGoals: state.shortTermGoals });
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
  /** Every committed qualifying event is counted even when the trailing lock coalesces its work. */
  private readonly pendingAutoCheckEvents = new Map<string, number>();
  private readonly forwardStateJobs = new Map<string, Promise<void>>();
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
   * Generate objectives from the conversation, dispatching by mode: route mode
   * builds an ordered task route; goals mode builds one long-term + short-term
   * goals. Both preserve the existing config and replace only the generated
   * items; both discard a stale result if the user edited the items mid-flight.
   */
  async generateTasks(input: ObjectiveGenerateInput): Promise<ObjectiveState> {
    return this.llmCoordinator.run(input.chatId, async () => {
      input.signal?.throwIfAborted();
      const state = await this.getState(input.chatId);
      return state.mode === OBJECTIVE_MODE.goals
        ? this.generateGoalsTasks(input, state)
        : this.generateRouteTasks(input, state);
    });
  }

  /** Route mode: generate an ordered task route from the conversation. */
  private async generateRouteTasks(input: ObjectiveGenerateInput, state: ObjectiveState): Promise<ObjectiveState> {
    input.signal?.throwIfAborted();
    const revision = routeRevision(state);
    const instructionBase = await this.resolvePrompt("objectiveGenerate", state.generatePrompt);
    const instruction = composeGenerateInstruction(instructionBase, state.objectiveDescription);
    const prompt = this.buildPrompt(input.context, instruction);
    const result = await this.execute({ profile: input.profile, model: input.model, prompt, signal: input.signal });
    input.signal?.throwIfAborted();
    const parsed = parseTaskList(result.text);
    if (parsed.length === 0) {
      throw new Error("Objective generation produced no tasks — try adjusting the objective description or the generate prompt.");
    }
    // Auto-activate the first task so the route has an explicit current
    // target the moment it is generated; the rest stay pending until reached.
    const tasks = parsed.map((task, index) =>
      index === 0 ? { ...task, status: OBJECTIVE_TASK_STATUS.active } : task,
    );

    // CRUD/config remain responsive during the LLM await. Re-read and merge
    // only the generated route; if the user edited the route/goal itself,
    // discard this stale generation rather than overwriting their intent.
    return this.commitState(input.chatId, (current) => {
      if (routeRevision(current) !== revision) return null;
      return { ...current, tasks };
    }, input.signal);
  }

  /** Goals mode: generate one long-term goal + short-term goals (first short-term auto-active). */
  private async generateGoalsTasks(input: ObjectiveGenerateInput, state: ObjectiveState): Promise<ObjectiveState> {
    input.signal?.throwIfAborted();
    const revision = goalsRevision(state);
    const instructionBase = await this.resolvePrompt("objectiveGenerateGoals", state.generatePrompt);
    const instruction = composeGenerateGoalsInstruction(instructionBase);
    const prompt = this.buildPrompt(input.context, instruction);
    const result = await this.execute({ profile: input.profile, model: input.model, prompt, signal: input.signal });
    input.signal?.throwIfAborted();
    const parsed = parseGoalsResult(result.text);
    // Auto-activate the first short-term goal as the current focus; the rest stay pending.
    const shortTermGoals = parsed.shortTermGoals.map((goal, index) =>
      index === 0 ? { ...goal, status: OBJECTIVE_TASK_STATUS.active } : goal,
    );

    return this.commitState(input.chatId, (current) => {
      if (goalsRevision(current) !== revision) return null;
      return { ...current, longTermGoal: parsed.longTermGoal, shortTermGoals };
    }, input.signal);
  }

  /**
   * Ask the LLM whether the current active target is complete; if so, mark it
   * 'completed'. Dispatches by mode: route mode checks the active task; goals
   * mode checks the selected short-term goal. The long-term goal is never
   * auto-checked — it is completed manually. No-op when there is no active
   * target or the LLM says PENDING. Returns the (possibly updated) state.
   */
  async checkCompletion(input: ObjectiveCheckInput): Promise<ObjectiveState> {
    return this.llmCoordinator.run(input.chatId, async () => {
      input.signal?.throwIfAborted();
      const state = await this.getState(input.chatId);
      return state.mode === OBJECTIVE_MODE.goals
        ? this.checkGoalsCompletion(input, state)
        : this.checkRouteCompletion(input, state);
    });
  }

  /** Route mode: check the active task; if complete, advance the route. */
  private async checkRouteCompletion(input: ObjectiveCheckInput, state: ObjectiveState): Promise<ObjectiveState> {
    input.signal?.throwIfAborted();
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
  }

  /** Goals mode: check the selected short-term goal; if complete, mark it completed. */
  private async checkGoalsCompletion(input: ObjectiveCheckInput, state: ObjectiveState): Promise<ObjectiveState> {
    input.signal?.throwIfAborted();
    const target = selectActiveTask(state.shortTermGoals);
    if (!target) return state;
    const instructionBase = await this.resolvePrompt("objectiveCheck", state.checkPrompt);
    const instruction = composeCheckGoalsInstruction(instructionBase, state.longTermGoal?.description ?? null, target.description);
    const prompt = this.buildPrompt(input.context, instruction);
    const result = await this.execute({ profile: input.profile, model: input.model, prompt, signal: input.signal });
    input.signal?.throwIfAborted();
    const completed = parseCheckVerdict(result.text);
    if (!completed) return this.getState(input.chatId);

    return this.commitState(input.chatId, (current) => {
      const currentTarget = selectActiveTask(current.shortTermGoals);
      const matching = current.shortTermGoals.find((goal) => goal.id === target.id);
      if (
        currentTarget?.id !== target.id ||
        !matching ||
        matching.description !== target.description ||
        matching.status !== target.status
      ) {
        return null;
      }
      return { ...current, shortTermGoals: advanceAfterCompletion(current.shortTermGoals) };
    }, input.signal);
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
   * Goals mode (OGM): switch the tracker mode (route ↔ goals). Preserves the
   * other mode's data — switching back restores it exactly. The mode lives in
   * the same JSON blob; no field is cleared.
   */
  async setObjectiveMode(chatId: ChatId, mode: ObjectiveMode): Promise<ObjectiveState> {
    return this.commitState(chatId, (base) => ({ ...base, mode }));
  }

  /**
   * Goals mode (OGM): create or update the long-term goal. Patching a
   * description when none exists creates it (status pending); patching status
   * cycles it. Throws when a non-empty description is required but missing.
   */
  async updateLongTermGoal(chatId: ChatId, patch: Partial<Pick<ObjectiveLongTermGoal, "description" | "status">>): Promise<ObjectiveState> {
    const description = patch.description?.trim();
    if (patch.description !== undefined && !description) throw new Error("Long-term goal description is required.");
    if (patch.status !== undefined && !isObjectiveTaskStatus(patch.status)) {
      throw new Error(`Unknown objective task status: '${String(patch.status)}'.`);
    }
    return this.commitState(chatId, (base) => {
      const nextDescription = description ?? base.longTermGoal?.description;
      if (!nextDescription) throw new Error("Long-term goal description is required.");
      const nextStatus = patch.status ?? base.longTermGoal?.status ?? OBJECTIVE_TASK_STATUS.pending;
      return { ...base, longTermGoal: { description: nextDescription, status: nextStatus } };
    });
  }

  /** Goals mode (OGM): append a new 'pending' short-term goal. */
  async addShortTermGoal(chatId: ChatId, description: string): Promise<ObjectiveState> {
    const normalizedDescription = description.trim();
    if (!normalizedDescription) throw new Error("Short-term goal description is required.");
    return this.commitState(chatId, (base) => ({
      ...base,
      shortTermGoals: [...base.shortTermGoals, {
        id: `obj_st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        description: normalizedDescription,
        status: OBJECTIVE_TASK_STATUS.pending,
      }],
    }));
  }

  /** Goals mode (OGM): patch a short-term goal (description and/or status). Setting one goal 'active' demotes any other active goal (one-active invariant). */
  async updateShortTermGoal(chatId: ChatId, goalId: string, patch: Partial<Pick<ObjectiveShortTermGoal, "description" | "status">>): Promise<ObjectiveState> {
    const description = patch.description?.trim();
    if (patch.description !== undefined && !description) throw new Error("Short-term goal description is required.");
    if (patch.status !== undefined && !isObjectiveTaskStatus(patch.status)) {
      throw new Error(`Unknown objective task status: '${String(patch.status)}'.`);
    }
    return this.commitState(chatId, (base) => {
      let found = false;
      const shortTermGoals = base.shortTermGoals.map((goal) => {
        if (goal.id === goalId) {
          found = true;
          return {
            ...goal,
            ...(description !== undefined ? { description } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
          };
        }
        if (patch.status === OBJECTIVE_TASK_STATUS.active && goal.status === OBJECTIVE_TASK_STATUS.active) {
          return { ...goal, status: OBJECTIVE_TASK_STATUS.pending };
        }
        return goal;
      });
      if (!found) throw new Error(`Short-term goal '${goalId}' not found in chat '${chatId}'.`);
      return { ...base, shortTermGoals };
    });
  }

  /** Goals mode (OGM): remove a short-term goal. Throws if the id is unknown. */
  async deleteShortTermGoal(chatId: ChatId, goalId: string): Promise<ObjectiveState> {
    return this.commitState(chatId, (base) => {
      if (!base.shortTermGoals.some((goal) => goal.id === goalId)) {
        throw new Error(`Short-term goal '${goalId}' not found in chat '${chatId}'.`);
      }
      return { ...base, shortTermGoals: base.shortTermGoals.filter((goal) => goal.id !== goalId) };
    });
  }

  /** Goals mode (OGM): select one short-term goal as the active focus (demotes any other active). */
  async selectShortTermGoal(chatId: ChatId, goalId: string): Promise<ObjectiveState> {
    return this.commitState(chatId, (base) => {
      if (!base.shortTermGoals.some((goal) => goal.id === goalId)) {
        throw new Error(`Short-term goal '${goalId}' not found in chat '${chatId}'.`);
      }
      const shortTermGoals = base.shortTermGoals.map((goal) =>
        goal.id === goalId
          ? { ...goal, status: OBJECTIVE_TASK_STATUS.active }
          : goal.status === OBJECTIVE_TASK_STATUS.active
            ? { ...goal, status: OBJECTIVE_TASK_STATUS.pending }
            : goal,
      );
      return { ...base, shortTermGoals };
    });
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
        if (next.autoCheckFrequency === 0) next.autoCheckEventCount = 0;
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
   * Wait for the chat's current automatic forward-state mutation to commit.
   * Cancelling detaches this waiter; it never aborts the shared background job.
   */
  async waitForForwardState(chatId: ChatId, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const job = this.forwardStateJobs.get(chatId as string);
    if (!job) return;
    if (!signal) {
      await job;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => settle(() => reject(signal.reason));

      signal.addEventListener("abort", onAbort, { once: true });
      void job.then(
        () => settle(resolve),
        (error: unknown) => settle(() => reject(error)),
      );
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
    this.pendingAutoCheckEvents.set(lockKey, (this.pendingAutoCheckEvents.get(lockKey) ?? 0) + 1);

    // Calls dropped into an existing trailing run must join its owner promise,
    // not replace it with their immediately-resolved `false` result.
    const ownsForwardStateJob = !this.autoCheckLocks.has(lockKey);
    const lockRun = this.autoCheckLocks.runExclusiveTrailing(
      lockKey,
      async () => {
        // Trailing runs consume the latest immutable event identity, not the
        // first closure's branch. Every read and context build targets it.
        const latest = this.latestAutoTrigger.get(lockKey);
        if (!latest) return;
        const chat = await this.stores.chats.getById(latest.chatId);
        if (!chat || !isObjectiveEnabled(chat.insightsConfig)) {
          this.pendingAutoCheckEvents.delete(lockKey);
          return;
        }
        const chatId = chat.id as ChatId;
        const branchId = brandId<ChatBranchId>(latest.branchId);
        const state = await this.getState(chatId);
        if (state.autoCheckFrequency <= 0 || !selectActiveTask(state.tasks)) {
          this.pendingAutoCheckEvents.delete(lockKey);
          return;
        }

        // The lock may coalesce many rapid events into one trailing run, but
        // cadence must not under-count them. Drain the exact pending total into
        // the persisted state before deciding whether a check is due.
        const pendingEvents = this.pendingAutoCheckEvents.get(lockKey) ?? 0;
        this.pendingAutoCheckEvents.delete(lockKey);
        let cadenceState: ObjectiveState;
        try {
          cadenceState = await this.commitState(chatId, (current) => {
            if (current.autoCheckFrequency <= 0 || !selectActiveTask(current.tasks)) return null;
            return {
              ...current,
              autoCheckEventCount: current.autoCheckEventCount + pendingEvents,
            };
          });
        } catch (err) {
          this.pendingAutoCheckEvents.set(
            lockKey,
            (this.pendingAutoCheckEvents.get(lockKey) ?? 0) + pendingEvents,
          );
          throw err;
        }
        if (cadenceState.autoCheckEventCount < cadenceState.autoCheckFrequency) return;

        const resolved = await this.resolveInsightProvider(cadenceState);
        if (!resolved) {
          logSendDebug("insights.objective.auto.skip", { chatId: chat.id, messageId: latest.messageId, reason: cadenceState.useChatModel ? "no_provider" : "no_provider_or_model" });
          return;
        }
        const { profile, model } = resolved;
        const built = await this.sessionRuntime.chatLifecycle.buildPipelineContext({
          chatId,
          branchId,
          model,
          recentMessageLimit: cadenceState.contextWindow,
        });
        const checkedThroughCount = cadenceState.autoCheckEventCount;
        await this.checkCompletion({ chatId, profile, model, context: built.context });

        // Reset only the events represented by this check. Events committed
        // during the LLM await remain pending/persisted for the trailing run.
        await this.commitState(chatId, (current) => {
          const autoCheckEventCount = Math.max(0, current.autoCheckEventCount - checkedThroughCount);
          return autoCheckEventCount === current.autoCheckEventCount
            ? null
            : { ...current, autoCheckEventCount };
        });
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
    const forwardStateJob = lockRun.then(() => undefined);
    if (ownsForwardStateJob) this.forwardStateJobs.set(lockKey, forwardStateJob);

    let ran = false;
    try {
      ran = await lockRun;
    } finally {
      if (ownsForwardStateJob && this.forwardStateJobs.get(lockKey) === forwardStateJob) {
        this.forwardStateJobs.delete(lockKey);
      }
    }

    // The lock owner has consumed every dirty trailing trigger before `ran`
    // resolves. Dropped callers return `false`, so only the owner cleans up.
    if (ran) {
      this.latestAutoTrigger.delete(lockKey);
      if ((this.pendingAutoCheckEvents.get(lockKey) ?? 0) === 0) {
        this.pendingAutoCheckEvents.delete(lockKey);
      }
    }
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
