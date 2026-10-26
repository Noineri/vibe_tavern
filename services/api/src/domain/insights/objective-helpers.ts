/**
 * The PURE helpers of the Objective Tracker (INSIGHTS_PLAN INS-3b/INS-3c) —
 * strict-JSON parsing of the generation/check model output, the active-target
 * select/advance invariants, and the InsightsAssembler → executor DTO map.
 * Extracted from objective-service.ts (DR-3a's arch-gate ratchet: the service
 * file could not grow), which re-exports every public name for existing
 * importers — behavior and signatures are unchanged, byte-for-byte moves.
 */
import type {
  AssemblePromptResponse,
  ObjectiveLongTermGoal,
  ObjectiveShortTermGoal,
  ObjectiveTask,
} from "@vibe-tavern/domain";
import { OBJECTIVE_TASK_STATUS } from "@vibe-tavern/domain";
import type { PromptAssemblyResult } from "@vibe-tavern/prompt-pipeline";
import { z } from "zod";
import { parseStructuredOutput } from "./structured-output.js";

const generatedTaskRouteSchema = z.object({
  tasks: z.array(z.object({ description: z.string().trim().min(1) }).strict()).min(1),
}).strict();

const generatedGoalsSchema = z.object({
  longTerm: z.object({ description: z.string().trim().min(1) }).strict(),
  shortTerm: z.array(z.object({ description: z.string().trim().min(1) }).strict()).min(1),
}).strict();

const completionVerdictSchema = z.object({ completed: z.boolean() }).strict();

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
 * array (no mutation). The next 'pending' implicitly becomes the target on
 * the next selectActiveTask call. No-op when there is no active target.
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
