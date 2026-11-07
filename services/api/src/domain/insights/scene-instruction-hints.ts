/**
 * Per-turn Scene instruction hints (R10 + the SCN-5 label hints + the DK-2
 * clock hint).
 *
 * `composeSceneInstruction` sends the tracker model `stripLabels(schema)` — the
 * whitelist projection that drops `label`, `tone` and `toneBy` so presentation
 * can never reach `schemaHash`. Everything the model still needs that the bare
 * projection cannot say travels as SEPARATE hint blocks built here, next to
 * (never inside) the schema JSON: human labels, the exact words a `toneBy` map
 * colors, and the meaning of the schema's clock-marked fields (`clock` itself
 * rides the projection and the schema hash — it is semantic — but its RULES
 * day starts at 1, the four part words — are taught here).
 */
import { SCENE_CLOCK_MARKER, STORY_DAY_PART, findSceneClockField } from "@vibe-tavern/domain";
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

/**
 * The story clock hint block (DK-2), appended to the Scene instruction, or ""
 * when the schema marks no clock fields (the instruction is then
 * byte-identical to one built without this feature). ONE block — never one per
 * field — describing what each clock-marked field means: the day counter
 * starts at 1 and grows when a night passes, the part-of-day field is a CLOSED
 * enum over exactly the four `STORY_DAY_PART` words (the same word set
 * `readStoryClock` accepts — an off-list word is dropped from the clock, so
 * unlike the toneBy vocabulary this is a rule, not a preference), and the
 * date-label field carries free-form display text. The words are read from the
 * domain const, so the hint and the reader cannot drift apart.
 */
export function composeStoryClockBlock(dsl: SceneTrackerDsl): string {
	const day = findSceneClockField(dsl, SCENE_CLOCK_MARKER.day);
	const part = findSceneClockField(dsl, SCENE_CLOCK_MARKER.part);
	const label = findSceneClockField(dsl, SCENE_CLOCK_MARKER.label);
	if (!day && !part && !label) return "";
	const sentences: string[] = [];
	if (day) {
		sentences.push(
			`the story day field "${day.key}" is the 1-based day counter: it starts at 1 and grows by 1 when the night passes (a new day begins at morning)`,
		);
	}
	if (part) {
		const words = Object.values(STORY_DAY_PART).map((word) => `"${word}"`).join(", ");
		sentences.push(
			`the part-of-day field "${part.key}" accepts exactly one of these four words, unchanged — same spelling and case: ${words} (closed set; no other word is valid there)`,
		);
	}
	if (label) {
		sentences.push(
			`the date-label field "${label.key}" carries a free-form display label for the current in-story date (keep it consistent with the day/part values)`,
		);
	}
	return `\n\nStory clock (the schema marks these fields as the story clock): ${sentences.join("; ")}.`;
}
