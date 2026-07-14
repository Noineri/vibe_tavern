/**
 * Scene Tracker prompt injection (SCENE_TRACKER_PLAN SCN-7).
 *
 * Pure formatting helpers that turn the validated `sceneState` objects (one per
 * tracked assistant turn, oldest→newest) into the text body of the main-model
 * `sceneState` injection layer. The service (prompt-assembly-service) owns the
 * DB query + freshness filter + last-N selection; this module owns ONLY the
 * deterministic, side-effect-free serialization. XML keys and values are escaped
 * so model-generated content can never break out of the tag structure.
 *
 * Generation output is ALWAYS strict schema-validated JSON (SCN-5); the
 * `format` here controls only how the already-validated block is serialized for
 * the MAIN model's prompt — it never parses model free-text.
 */

/** A single tracked turn's validated scene state (DSL leaf values). */
export type SceneInjectionEntry = Readonly<Record<string, unknown>>;

export type SceneInjectionFormat = "json" | "xml";

const XML_ENTITIES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&apos;",
};

/** Escape XML special characters in a string value or tag name. */
export function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => XML_ENTITIES[ch] ?? ch);
}

/** Render a single scene's leaf values as nested `<key>value</key>` tags. */
function sceneToXml(entry: SceneInjectionEntry, index: number): string {
	const fields = Object.entries(entry)
		.filter(([, v]) => v !== undefined && v !== null)
		.map(([key, value]) => `\t<${escapeXml(key)}>${escapeXml(String(value))}</${escapeXml(key)}>`)
		.join("\n");
	return `<scene index="${index + 1}">\n${fields}\n</scene>`;
}

/**
 * Serialize the scene history (oldest→newest) into the layer body text.
 *
 * - `"json"` — a numbered list of compact JSON objects, "latest last".
 * - `"xml"` — a `<scene_history>` block of `<scene>` elements, one per turn,
 *   each leaf as an escaped `<key>value</key>` tag.
 *
 * An empty history yields an empty string (the caller drops the layer when there
 * is nothing to inject, so this is purely defensive).
 */
export function formatSceneHistory(
	entries: ReadonlyArray<SceneInjectionEntry>,
	format: SceneInjectionFormat,
): string {
	if (entries.length === 0) return "";
	if (format === "xml") {
		const scenes = entries.map((entry, index) => sceneToXml(entry, index)).join("\n");
		return `<scene_history>\n${scenes}\n</scene_history>`;
	}
	const lines = entries.map((entry, index) => `${index + 1}. ${JSON.stringify(entry)}`);
	return `Scene history (latest last):\n${lines.join("\n")}`;
}
