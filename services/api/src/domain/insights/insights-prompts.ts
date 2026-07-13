/**
 * Insights prompt loading (INSIGHTS_PLAN INS-3c).
 *
 * The default instruction text for each insight one-shot (objective generate /
 * objective check / scene generate) lives in a `.md` asset file under
 * `services/api/assets/`, a peer to `script-ai-prompt.md`, `lore-entry-ai-prompt.md`,
 * etc. This module mirrors `ai-assistant-prompts.ts`'s override ladder: a per-chat
 * config override (`ObjectiveState.generatePrompt` / `checkPrompt`, scene
 * equivalent) replaces the default when non-empty; otherwise the `.md` default is
 * loaded via the shared `shared/prompt-asset-loader.ts` ladder (env → artifact →
 * assets → cwd → build, per-file cache).
 *
 * This module resolves the BASE instruction only. The caller (`ObjectiveService` /
 * `TrackerService`) composes the dynamic context (objective description / active
 * task / scene schema) onto it and passes the final string to the assembler. The
 * assembler itself stays pure — no I/O in the prompt-pipeline package.
 */
import { loadPromptAsset } from "../../shared/prompt-asset-loader.js";

/** Maps each insight one-shot to its default `.md` asset filename. */
export const INSIGHTS_PROMPT_FILES = {
  objectiveGenerate: "objective-generate.md",
  objectiveCheck: "objective-check.md",
  sceneGenerate: "scene-generate.md",
} as const;

export type InsightsPromptKey = keyof typeof INSIGHTS_PROMPT_FILES;

/**
 * Resolve the base instruction for an insight one-shot: per-chat override when
 * non-empty, otherwise the `.md` default. Returns the trimmed text. The caller
 * composes dynamic context onto it.
 */
export async function resolveInsightsPrompt(
  key: InsightsPromptKey,
  override: string | null | undefined,
): Promise<string> {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;
  const loaded = await loadPromptAsset(INSIGHTS_PROMPT_FILES[key]);
  return loaded.trim();
}
