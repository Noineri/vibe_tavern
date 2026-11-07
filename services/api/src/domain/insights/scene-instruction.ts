/**
 * The composed per-turn Scene tracker instruction (extracted from
 * tracker-service.ts by the file-size ratchet — DK-2 touched
 * {@link composeSceneInstruction} to append the story clock hint block).
 *
 * This module owns the final instruction assembly: the override-or-default
 * base + the bounded schema descriptor + the continuity window + the hint
 * blocks (labels, toneBy vocabulary, story clock — all built in
 * `scene-instruction-hints.ts`). Pure string composition, no I/O.
 */
import { stripLabels } from "@vibe-tavern/domain";
import type { MessageVariantId, SceneTrackerDsl } from "@vibe-tavern/domain";
import { collectLabelHints, composeStoryClockBlock, composeToneVocabularyBlock } from "./scene-instruction-hints.js";

/** One prior valid selected-variant record fed to the model as continuity input. */
export interface SceneContinuityRecord {
	variantId: MessageVariantId;
	sceneState: Record<string, unknown>;
}

/**
 * Compose the final Scene instruction: override-or-default base + the bounded
 * schema descriptor (so the model knows exactly which fields to fill) + the
 * continuity window (prior states to evolve from). The base is `scene-generate.md`
 * unless a per-chat override is set; this function only appends dynamic context.
 */
export function composeSceneInstruction(
	base: string,
	schema: SceneTrackerDsl,
	continuity: readonly SceneContinuityRecord[],
	rulesPrompt = "",
): string {
	const schemaJson = JSON.stringify(stripLabels(schema));
	const continuityJson =
		continuity.length > 0 ? JSON.stringify(continuity.map((record) => record.sceneState)) : "[]";
	const labelHints = collectLabelHints(schema);
	const labelBlock = labelHints.length > 0
		? `\n\nField labels (human names for the schema keys; they do NOT add, rename, or remove any field — output the machine keys exactly as in the schema): ${JSON.stringify(labelHints)}`
		: "";
	const trimmedRules = rulesPrompt.trim();
	const rulesBlock = trimmedRules.length > 0
		? `\n\nScene tracker rules for this chat (author-specified; these OVERRIDE the base defaults — obey the formulas, per-turn deltas, bounds/gates, and starting values below):\n${trimmedRules}`
		: "";
	return (
		`${base}${rulesBlock}\n\n` +
		`Scene schema (produce one JSON object with exactly these fields, no extras): ${schemaJson}\n\n` +
		`Recent scene continuity (prior states — evolve them to match the current scene): ${continuityJson}` +
		labelBlock +
		composeToneVocabularyBlock(schema) +
		composeStoryClockBlock(schema) +
		`\n\nRequired output: one JSON object matching the schema exactly.`
	);
}
