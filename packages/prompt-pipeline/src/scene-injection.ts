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

/** Render a single scene's values as nested XML. Primitives become inline
 *  `<key>value</key>` tags; objects recurse into `<key><child>…</child></key>`;
 *  arrays become `<key><item>…</item>…</key>` (one `<item>` child per element,
 *  mirroring the JSON shape). This recurses so a nested object never serializes
 *  to `[object Object]` and an array never collapses to a comma-joined string
 *  (the bug the previous flat `String(value)` leaf shipped). Keys and values are
 *  escaped so model-generated content can never break out of the tag structure. */
function sceneToXml(entry: SceneInjectionEntry, index: number): string {
	const fields = Object.entries(entry)
		.filter(([, v]) => v !== undefined && v !== null)
		.map(([key, value]) => renderTag(key, value, 1))
		.join("\n");
	return `<scene index="${index + 1}">\n${fields}\n</scene>`;
}

/** Render `<tag>…</tag>` for one field/item value at `depth` (tab-indented).
 *  - primitive → inline `<tag>escaped</tag>`;
 *  - object → `<tag>\n  <child>…</child>\n</tag>` (each property recursed, nulls skipped);
 *  - array → `<tag>\n  <item>…</item>\n</tag>` (one `<item>` per element, recursed);
 *  - empty object/array or null → `<tag></tag>` (preserves the key, no children). */
function renderTag(tag: string, value: unknown, depth: number): string {
	const name = escapeXml(tag);
	const pad = "\t".repeat(depth);
	if (value === null || value === undefined) return `${pad}<${name}></${name}>`;
	if (Array.isArray(value)) {
		if (value.length === 0) return `${pad}<${name}></${name}>`;
		const inner = value.map((item) => renderTag("item", item, depth + 1)).join("\n");
		return `${pad}<${name}>\n${inner}\n${pad}</${name}>`;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null);
		if (entries.length === 0) return `${pad}<${name}></${name}>`;
		const inner = entries.map(([k, v]) => renderTag(k, v, depth + 1)).join("\n");
		return `${pad}<${name}>\n${inner}\n${pad}</${name}>`;
	}
	return `${pad}<${name}>${escapeXml(String(value))}</${name}>`;
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
