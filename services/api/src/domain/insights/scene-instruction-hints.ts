/**
 * Per-turn Scene instruction hints (R10 + the SCN-5 label hints).
 *
 * `composeSceneInstruction` sends the tracker model `stripLabels(schema)` — the
 * whitelist projection that drops `label`, `tone` and `toneBy` so presentation
 * can never reach `schemaHash`. Everything the model still needs from those
 * presentation fields travels as SEPARATE hint blocks built here, next to (never
 * inside) the schema JSON: human labels, and the exact words a `toneBy` map
 * colors.
 */
import type { SceneTrackerDsl, SceneTrackerSchemaNode } from "@vibe-tavern/domain";

/** Collect `label` hints (human names for machine keys) recursively. They are sent
 *  SEPARATELY from the schema JSON so a label can never affect `schemaHash` (it is
 *  renderer-only presentation). The model still outputs the machine keys, but can
 *  read the human meaning of each field (e.g. `obedience` → "Silvius's Obedience"). */
export function collectLabelHints(dsl: SceneTrackerDsl): string[] {
	const hints: string[] = [];
	const walk = (path: string, node: SceneTrackerSchemaNode): void => {
		if (node.label) hints.push(`${path}: ${node.label}`);
		if (node.$type === "object") {
			for (const [key, child] of Object.entries(node.properties)) walk(`${path}.${key}`, child);
		} else if (node.$type === "array") {
			walk(`${path}[]`, node.items);
		}
	};
	for (const [key, node] of Object.entries(dsl)) walk(key, node);
	return hints;
}

/** One string field whose `toneBy` map colors specific words. */
export interface ToneVocabularyHint {
	/** Same path shape as the label hints: `key`, `parent.child`, `list[].field`. */
	path: string;
	/** The `toneBy` keys verbatim, in map order. */
	words: string[];
}

/** Collect the `toneBy` vocabulary of every STRING node with a non-empty map.
 *  Like the label hints it is sent SEPARATELY from the schema JSON (tones are
 *  presentation-only and never reach `schemaHash`); without it the tracker model
 *  never learns the exact words a color keys on. */
export function collectToneVocabularyHints(dsl: SceneTrackerDsl): ToneVocabularyHint[] {
	const hints: ToneVocabularyHint[] = [];
	const walk = (path: string, node: SceneTrackerSchemaNode): void => {
		if (node.$type === "string") {
			const words = node.toneBy ? Object.keys(node.toneBy) : [];
			if (words.length > 0) hints.push({ path, words });
		} else if (node.$type === "object") {
			for (const [key, child] of Object.entries(node.properties)) walk(`${path}.${key}`, child);
		} else if (node.$type === "array") {
			walk(`${path}[]`, node.items);
		}
	};
	for (const [key, node] of Object.entries(dsl)) walk(key, node);
	return hints;
}

/** The vocabulary paragraph appended to the Scene instruction, or "" when no
 *  string node carries a `toneBy` map (the instruction is then byte-identical to
 *  one built without this feature). The list is a preference, not a closed enum. */
export function composeToneVocabularyBlock(dsl: SceneTrackerDsl): string {
	const hints = collectToneVocabularyHints(dsl);
	if (hints.length === 0) return "";
	const vocabulary = Object.fromEntries(hints.map((hint) => [hint.path, hint.words]));
	return (
		`\n\nPreferred value words (for these string fields, when one of the listed words fits the scene, ` +
		`output exactly that word, unchanged — same spelling, case and language; when none of them fits, ` +
		`write the value that does — the list is a preference, not a closed enum): ${JSON.stringify(vocabulary)}`
	);
}
