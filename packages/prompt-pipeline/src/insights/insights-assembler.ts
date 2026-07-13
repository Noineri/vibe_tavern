/**
 * Pure per-kind assembly seam for insight one-shots (INSIGHTS_PLAN INS-3c).
 *
 * The Objective and Scene trackers each need a SECONDARY LLM call — generate
 * (produce a task route / scene JSON) and check (is the active task done?) —
 * whose prompt is the chat's full RP world context (character / persona /
 * activated lorebook / script injections / recent window, under the same preset
 * toggles the main model uses) PLUS a single instruction as the final user
 * message. This is the fourth top-level prompt builder, a peer to
 * `SummaryStrategy` and `AiAssistantAssembler` (see
 * `docs/architecture/prompt-pipeline.md` § Registries).
 *
 * Unlike `AiAssistantAssembler` (which builds a minimal assistant prompt from
 * scratch), this one REUSES the chat-turn pipeline — `assembleInsightsPrompt`
 * runs `buildLayers` + `finalizeAssembly`, stripping only the insight
 * self-injection layers (`objectiveTask` / `sceneState`). So the insight model
 * sees exactly what the main model sees, minus the insight layers that would
 * duplicate the instruction, plus the instruction. `mes_example`, lore
 * activation, authorsNote all follow the chat's own toggles — no insight-specific
 * visibility policy.
 *
 * Like the other registries this is PURE: prompt in, `PromptAssemblyResult` out.
 * LLM invocation, storage, provider resolution, and instruction-text loading
 * (override-or-default from the `.md` assets) all stay with the caller
 * (`ObjectiveService` / `TrackerService`). The caller resolves the final
 * instruction string and passes it in.
 *
 * Both kinds currently share one `DefaultInsightsAssembler`; the registry shape
 * (`satisfies Record<InsightsKind, InsightsAssembler>`, see
 * `insights-assemblers.ts`) is what lets a divergent kind slot in later without
 * touching the chat pipeline.
 */
import type { PromptAssemblyContext, PromptAssemblyResult } from "../types.js";
import { assembleInsightsPrompt } from "../assemble.js";

/** Which insight feature a one-shot prompt is for. */
export type InsightsKind = "objective" | "scene";

/** Pure per-kind assembly seam for insight one-shots. */
export interface InsightsAssembler {
  assemble(context: PromptAssemblyContext, instruction: string): PromptAssemblyResult;
}

export function assembleInsights(context: PromptAssemblyContext, instruction: string): PromptAssemblyResult {
  return assembleInsightsPrompt(context, instruction);
}

export const DefaultInsightsAssembler: InsightsAssembler = {
  assemble: assembleInsights,
};
