/**
 * Objective Tracker service (INSIGHTS_PLAN INS-3b).
 *
 * Owns the Objective Tracker state for a chat: generating a task route from the
 * conversation, checking whether the active task is complete and advancing,
 * and the task CRUD. The LLM calls go through `nonstreamingProviderExecute`,
 * injected (default = the real executor) so the full generate → parse → persist
 * and check → advance paths are unit-testable without `mock.module()` (per
 * AGENTS.md §1.4 — inject the dep, don't mock it globally).
 *
 * The service does NOT assemble the conversation context itself — the caller
 * (the route / FeatureModule in INS-4) supplies an assembled
 * `AssemblePromptResponse` (recent RP context); the service appends the
 * objective instruction as the final user message and sends. This keeps the
 * service focused on objective LOGIC (parse / select / advance / persist) and
 * the prompt-pipeline plumbing in INS-4.
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
import type { AssemblePromptResponse, ChatId, ObjectiveState, ObjectiveTask } from "@vibe-tavern/domain";
import { OBJECTIVE_TASK_STATUS } from "@vibe-tavern/domain";
import type { StoreContainer } from "@vibe-tavern/db";
import { nonstreamingProviderExecute } from "../../infrastructure/ai/nonstreaming-provider-executor.js";
import type { ProviderExecutionInput } from "../../infrastructure/ai/provider-execution-types.js";

type Execute = typeof nonstreamingProviderExecute;
type ResolvedProfile = ProviderExecutionInput["profile"];

/** Default ObjectiveState for a chat that has none yet (or for addTask on an empty chat). */
export function defaultObjectiveState(): ObjectiveState {
  return {
    objectiveDescription: "",
    tasks: [],
    autoCheckFrequency: 0,
    injectionDepth: 1,
    generatePrompt: "",
    checkPrompt: "",
    injectPrompt: "",
  };
}

/**
 * Parse an LLM task-list response into typed tasks. Accepts numbered
 * (`1.`, `1)`) and bulleted (`-`, `*`) lines; everything else is ignored (so
 * preamble/chatter doesn't pollute the route). All parsed tasks start 'pending'.
 */
export function parseTaskList(text: string): ObjectiveTask[] {
  const tasks: ObjectiveTask[] = [];
  let i = 0;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:\d+[\.)]|[-*])\s+(.+?)\s*$/);
    if (!m) continue;
    const description = m[1].trim();
    if (!description) continue;
    i += 1;
    tasks.push({ id: `obj_task_${i}`, description, status: OBJECTIVE_TASK_STATUS.pending });
  }
  return tasks;
}

/**
 * Parse the check-LLM's verdict. Returns true when the active task is judged
 * complete. Keyword-based (DONE / COMPLETE(D) / FINISHED / ACCOMPLISHED / YES),
 * case-insensitive; defaults to NOT complete so a garbled response never
 * falsely advances the route.
 */
export function parseCheckVerdict(text: string): boolean {
  return /\b(DONE|COMPLETE[D]?|FINISHED|ACCOMPLISHED|YES)\b/i.test(text.trim());
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
 * Append the objective instruction as the FINAL user message of an assembled
 * context prompt (mirrors `withSummaryPromptAsFinalUserMessage`, but appends an
 * explicit instruction string instead of relocating a preset layer — the
 * objective instruction is dynamic, not a registered layer).
 */
export function withObjectiveInstructionAsFinalUserMessage(
  prompt: AssemblePromptResponse,
  instruction: string,
): AssemblePromptResponse {
  const payload = prompt.finalPayload as { messages?: unknown } | undefined;
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  return {
    ...prompt,
    finalPayload: {
      ...(prompt.finalPayload ?? {}),
      messages: [
        ...messages,
        { role: "user", content: instruction, layerId: "objective_instruction" },
      ],
    },
  };
}

function buildGenerateInstruction(generatePrompt: string, objectiveDescription: string): string {
  const lead = generatePrompt.trim()
    || "Break the objective below into a numbered list of concrete, sequential tasks the characters must accomplish to reach it. One task per line, formatted '1. ...'.";
  return `${lead}\n\nObjective: ${objectiveDescription.trim() || "(unspecified)"}`;
}

function buildCheckInstruction(checkPrompt: string, objectiveDescription: string, taskDescription: string): string {
  const lead = checkPrompt.trim()
    || "Read the conversation and decide whether the active task below has been accomplished in the story so far. Reply with a single word: DONE or PENDING.";
  return `${lead}\n\nObjective: ${objectiveDescription.trim() || "(unspecified)"}\nActive task: ${taskDescription}`;
}

function isObjectiveState(raw: unknown): raw is ObjectiveState {
  return typeof raw === "object" && raw !== null && Array.isArray((raw as ObjectiveState).tasks);
}

export interface ObjectiveGenerateInput {
  chatId: ChatId;
  profile: ResolvedProfile;
  model: string;
  /** Assembled recent RP context (caller-provided — see file doc). */
  contextPrompt: AssemblePromptResponse;
  signal?: AbortSignal;
}

export interface ObjectiveCheckInput extends ObjectiveGenerateInput {}

export class ObjectiveService {
  constructor(
    private readonly stores: StoreContainer,
    private readonly execute: Execute = nonstreamingProviderExecute,
  ) {}

  /** Load the chat's objective state, or null when none has been generated. */
  async getState(chatId: ChatId): Promise<ObjectiveState | null> {
    const chat = await this.stores.chats.getById(chatId);
    if (!chat) return null;
    return isObjectiveState(chat.insightsObjectiveState) ? chat.insightsObjectiveState : null;
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
    const existing = await this.getState(input.chatId);
    const base = existing ?? defaultObjectiveState();
    const instruction = buildGenerateInstruction(base.generatePrompt, base.objectiveDescription);
    const prompt = withObjectiveInstructionAsFinalUserMessage(input.contextPrompt, instruction);
    const result = await this.execute({ profile: input.profile, model: input.model, prompt, signal: input.signal });
    const tasks = parseTaskList(result.text);
    if (tasks.length === 0) {
      throw new Error("Objective generation produced no tasks — try adjusting the objective description or the generate prompt.");
    }
    const state: ObjectiveState = { ...base, tasks };
    await this.saveState(input.chatId, state);
    return state;
  }

  /**
   * Ask the LLM whether the current active task is complete; if so, mark it
   * 'completed' (advancing the route). No-op when there is no active task or the
   * LLM says PENDING. Returns the (possibly updated) state.
   */
  async checkCompletion(input: ObjectiveCheckInput): Promise<ObjectiveState> {
    const state = await this.getState(input.chatId);
    if (!state) return defaultObjectiveState();
    const target = selectActiveTask(state.tasks);
    if (!target) return state;
    const instruction = buildCheckInstruction(state.checkPrompt, state.objectiveDescription, target.description);
    const prompt = withObjectiveInstructionAsFinalUserMessage(input.contextPrompt, instruction);
    const result = await this.execute({ profile: input.profile, model: input.model, prompt, signal: input.signal });
    if (!parseCheckVerdict(result.text)) return state;
    const next: ObjectiveState = { ...state, tasks: advanceAfterCompletion(state.tasks) };
    await this.saveState(input.chatId, next);
    return next;
  }

  /** Append a new 'pending' task to the route (creating state if none exists). */
  async addTask(chatId: ChatId, description: string): Promise<ObjectiveState> {
    const base = (await this.getState(chatId)) ?? defaultObjectiveState();
    const task: ObjectiveTask = {
      id: `obj_task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      description,
      status: OBJECTIVE_TASK_STATUS.pending,
    };
    const next: ObjectiveState = { ...base, tasks: [...base.tasks, task] };
    await this.saveState(chatId, next);
    return next;
  }

  /** Patch a task (description and/or status). Throws if the task id is unknown. */
  async updateTask(chatId: ChatId, taskId: string, patch: Partial<Pick<ObjectiveTask, "description" | "status">>): Promise<ObjectiveState> {
    const base = (await this.getState(chatId)) ?? defaultObjectiveState();
    let found = false;
    const tasks = base.tasks.map((t) => {
      if (t.id !== taskId) return t;
      found = true;
      return { ...t, ...patch };
    });
    if (!found) throw new Error(`Objective task '${taskId}' not found in chat '${chatId}'.`);
    const next: ObjectiveState = { ...base, tasks };
    await this.saveState(chatId, next);
    return next;
  }

  /** Remove a task from the route. Throws if the task id is unknown. */
  async deleteTask(chatId: ChatId, taskId: string): Promise<ObjectiveState> {
    const base = (await this.getState(chatId)) ?? defaultObjectiveState();
    if (!base.tasks.some((t) => t.id === taskId)) {
      throw new Error(`Objective task '${taskId}' not found in chat '${chatId}'.`);
    }
    const next: ObjectiveState = { ...base, tasks: base.tasks.filter((t) => t.id !== taskId) };
    await this.saveState(chatId, next);
    return next;
  }

  /** Set/replace the objective description (the high-level goal). */
  async setObjectiveDescription(chatId: ChatId, objectiveDescription: string): Promise<ObjectiveState> {
    const base = (await this.getState(chatId)) ?? defaultObjectiveState();
    const next: ObjectiveState = { ...base, objectiveDescription };
    await this.saveState(chatId, next);
    return next;
  }

  private async saveState(chatId: ChatId, state: ObjectiveState): Promise<void> {
    await this.stores.chats.updateInsightsObjectiveState(chatId, {
      insightsObjectiveState: state as unknown as Record<string, unknown>,
    });
  }
}
