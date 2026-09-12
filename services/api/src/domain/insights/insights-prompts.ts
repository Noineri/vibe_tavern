/**
 * Insights prompt loading (INSIGHTS_PLAN INS-3c).
 *
 * The default instruction text for each insight one-shot (objective generate /
 * objective check / scene generate) lives in a `.md` asset file under
 * `services/api/assets/`, a peer to `script-ai-prompt.md`, `lore-entry-ai-prompt.md`,
 * etc. This module mirrors `ai-assistant-prompts.ts`'s override ladder — since
 * SP-5 it is three-tier: a per-chat config override (`ObjectiveState.generatePrompt`
 * / `checkPrompt`, scene equivalent) replaces the default when non-empty; then
 * the active service-prompt profile's field override (see
 * `domain/service-prompts/service-prompt-resolver.ts`); finally the `.md`
 * default is loaded via the shared `shared/prompt-asset-loader.ts` ladder
 * (env → artifact → assets → cwd → build, per-file cache).
 *
 * This module resolves the BASE instruction only. The caller (`ObjectiveService` /
 * `TrackerService`) composes the dynamic context (objective description / active
 * task / scene schema) onto it and passes the final string to the assembler. The
 * assembler itself stays pure — no I/O in the prompt-pipeline package.
 */
import type { AppDb } from "@vibe-tavern/db";
import type { ServicePromptFieldKey } from "@vibe-tavern/domain";
import { resolveServicePromptText } from "../service-prompts/service-prompt-resolver.js";
import { loadPromptAsset } from "../../shared/prompt-asset-loader.js";

/** Maps each insight one-shot to its default `.md` asset filename. */
export const INSIGHTS_PROMPT_FILES = {
  objectiveGenerate: "objective-generate.md",
  objectiveGenerateGoals: "objective-generate-goals.md",
  objectiveCheck: "objective-check.md",
  sceneGenerate: "scene-generate.md",
} as const;

export type InsightsPromptKey = keyof typeof INSIGHTS_PROMPT_FILES;

export const INSIGHTS_FIELD_MAP: Record<InsightsPromptKey, ServicePromptFieldKey> = {
  objectiveGenerate: "objective_generate",
  objectiveGenerateGoals: "objective_generate_goals",
  objectiveCheck: "objective_check",
  sceneGenerate: "scene_generate",
} as const;

/**
 * Resolve the base instruction for an insight one-shot: per-chat override when
 * non-empty, otherwise the active service-prompt profile override, otherwise
 * the `.md` default. Returns the trimmed text. The caller composes dynamic
 * context onto it.
 *
 * SP-5 three-tier chain: per-chat override → service-prompt profile → asset.
 * The db handle comes from the services' StoreContainer (`stores.db`) — the
 * objective/scene services wrap this in a small bound helper so their injected
 * test doubles keep the same two-arg contract (key, override).
 */
export async function resolveInsightsPromptWithProfile(
  db: AppDb,
  key: InsightsPromptKey,
  override: string | null | undefined,
): Promise<string> {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;
  const text = await resolveServicePromptText(db, INSIGHTS_FIELD_MAP[key]);
  return text.trim();
}

/** Two-arg form without profile access: per-chat override → asset directly.
 *  Kept as the injectable default seam (test doubles implement this shape). */
export async function resolveInsightsPrompt(
  key: InsightsPromptKey,
  override: string | null | undefined,
): Promise<string> {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;
  const loaded = await loadPromptAsset(INSIGHTS_PROMPT_FILES[key]);
  return loaded.trim();
}
