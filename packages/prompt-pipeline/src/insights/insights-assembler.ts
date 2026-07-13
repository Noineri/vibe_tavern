/**
 * Pure per-kind assembly seam for insight one-shots (INSIGHTS_PLAN INS-3c).
 *
 * The Objective and Scene trackers each need a SECONDARY LLM call — generate
 * (produce a task route / scene JSON) and check (is the active task done?) —
 * whose prompt shape is fundamentally unlike a chat turn: it is the recent
 * conversation window as real turns + a single instruction as the final user
 * message. NO RP stack (no character card / lore / authorsNote / the insight
 * layers themselves) — the insight model evaluates the committed conversation,
 * it does not re-enact it, and feeding it the RP stack would both bloat the
 * prompt and recurse (the objective/scene layers would inject into their own
 * check). This registry is the fourth top-level prompt builder, a peer to
 * `SummaryStrategy` and `AiAssistantAssembler` (see
 * `docs/architecture/prompt-pipeline.md` § Registries).
 *
 * Like the other registries this is PURE: prompt in, `PromptAssemblyResult`
 * out. LLM invocation, storage, provider resolution, and instruction-text
 * loading (override-or-default from the `.md` assets) all stay with the caller
 * (`ObjectiveService` / `TrackerService`) — never here. The caller resolves the
 * final instruction string and passes it in; this module only shapes it into a
 * prompt.
 *
 * Both kinds currently share one `DefaultInsightsAssembler`; the registry shape
 * (`satisfies Record<InsightsKind, InsightsAssembler>`, see
 * `insights-assemblers.ts`) is what lets a divergent kind slot in later without
 * touching the chat pipeline — exactly the AI-assistant pattern.
 */
import type { PromptAssemblyResult, PromptLayer } from "../types.js";
import { makeLayer, sortLayers } from "../assemble.js";
import {
  PROMPT_LAYER_ID,
  PROMPT_LAYER_PRIORITY,
  PROMPT_LAYER_SOURCE_TYPE,
} from "../prompt-layer-constants.js";

/** Which insight feature a one-shot prompt is for. */
export type InsightsKind = "objective" | "scene";

/**
 * A recent message in the insight model's context window. The caller slices the
 * last-N per the feature's `contextWindow` config (objective 10 / scene 6) and
 * filters to the dialogue roles — system/tool turns are not useful context for
 * an insight evaluation.
 */
export interface InsightsRecentMessage {
  role: "user" | "assistant";
  content: string;
}

/** Input to an insight one-shot assembly. */
export interface InsightsAssemblyInput {
  kind: InsightsKind;
  /** The committed conversation window (already sliced by the caller). */
  recentMessages: ReadonlyArray<InsightsRecentMessage>;
  /**
   * The final instruction — resolved override-or-default by the caller
   * (`insights-prompts.ts`) and composed with dynamic context (objective
   * description / active task / scene schema). Emitted as the final user
   * message so it reads as the thing the model must answer now.
   */
  instruction: string;
}

/** Pure per-kind assembly seam for insight one-shots. */
export interface InsightsAssembler {
  assemble(input: InsightsAssemblyInput): PromptAssemblyResult;
}

/**
 * Build an insight one-shot prompt. The recent window becomes real role-tagged
 * turns in `finalPayload.messages` (so the model sees proper dialogue structure)
 * and the instruction is appended as the final user message. For the trace, the
 * window is also represented as a single descriptive layer + the instruction
 * layer — mirroring how `AiAssistantAssembler` represents chat history.
 */
export function assembleInsights(input: InsightsAssemblyInput): PromptAssemblyResult {
  const layers: PromptLayer[] = [];

  // 1. Recent conversation window — one trace layer summarizing the window.
  const turns = input.recentMessages.filter((m) => m.content.trim());
  const windowText = turns
    .map((m) => `[${m.role}]: ${m.content.trim()}`)
    .join("\n\n");
  if (windowText.trim()) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.insightsContext,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.insights,
        sourceId: `${input.kind}_context`,
        sourceName: `${input.kind} context (${turns.length})`,
        priority: PROMPT_LAYER_PRIORITY.insightsContext,
        text: windowText,
      }),
    );
  }

  // 2. Instruction — the final user message.
  const instruction = input.instruction.trim();
  if (instruction) {
    layers.push(
      makeLayer({
        id: PROMPT_LAYER_ID.insightsInstruction,
        sourceType: PROMPT_LAYER_SOURCE_TYPE.insights,
        sourceId: `${input.kind}_instruction`,
        sourceName: `${input.kind} instruction`,
        priority: PROMPT_LAYER_PRIORITY.insightsInstruction,
        text: instruction,
      }),
    );
  }

  const orderedLayers = sortLayers(layers).filter((layer) => layer.text.length > 0);
  const totalTokenEstimate = orderedLayers.reduce((sum, layer) => sum + layer.tokenCount, 0);

  // finalPayload.messages: real role-tagged turns + the instruction as the
  // final user message (the layer representation above is trace-only).
  const messages: Array<{ role: "user" | "assistant"; content: string }> = turns.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  if (instruction) {
    messages.push({ role: "user", content: instruction });
  }

  return {
    layers: orderedLayers,
    totalTokenEstimate,
    activatedLoreEntries: [],
    usedMemoryBlocks: [],
    droppedLayers: [],
    finalPayload: { messages },
    prefill: null,
    compactionSummary: null,
  };
}

export const DefaultInsightsAssembler: InsightsAssembler = {
  assemble: assembleInsights,
};
