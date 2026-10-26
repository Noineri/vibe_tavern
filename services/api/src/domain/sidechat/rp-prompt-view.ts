/**
 * The RP prompt view renderer (SIDECHAT_PLAN Wave 5b / SC-23c, shared with
 * SC-23e) — PURE: plain inputs in, one `<rp_prompt>` string out. No store
 * reads or writes, no db import, no logger, clock, or randomness; nothing is
 * ever truncated.
 *
 * WHAT IT RENDERS: a prompt's FINAL PAYLOAD (the exact order, roles and
 * same-role merges the RP model received) with each payload entry's layer
 * attribution — the payload's own `layerId` / `messageId` plus `mergedFrom`,
 * the SAME attribution the trace UI reads (trace-payload-view.ts). A payload
 * entry every contributing layer of which the sidechat already holds becomes
 * a SELF-CLOSING PLACEHOLDER in its place, keeping its role; everything else
 * is shown in full, with its role and, for in-chat injects, its depth. The
 * difference IS the point: preset blocks and custom injects the sidechat
 * cannot see anywhere else arrive verbatim, while the card / persona /
 * shared lore / objectives / scene / history collapse to markers.
 *
 * «Already holds» (the context inventory's sidechat-visible rows, decided by
 * `PROMPT_LAYER_SOURCE_TYPE`): the card (`character`, `characterSystemPrompt`
 * — example messages and the character's depth/post-history prompts ride
 * `character`), `persona`, `loreEntry` ONLY when the same entry is in the
 * sidechat's current active lore (a lore entry the sidechat does NOT hold is
 * shown in full), `summaryMemory`, `objectiveTask` / `objectiveLongTerm`,
 * `sceneState`, and `chatHistory` (ONE placeholder per contiguous run of
 * history payload entries, carrying their positions). Everything else —
 * preset blocks and custom injects (`promptPreset`), author's note,
 * post-history instructions, insights instructions, script injections, tool
 * instructions, retrieval memory, media layers — is shown in full.
 *
 * PAYLOAD-FAITHFUL MERGES: a same-role merge that squashed held and non-held
 * layers into one payload entry renders as ONE full `<block>` carrying the
 * merged text (never re-split — re-splitting would invent boundaries the
 * model never saw); the entry is a placeholder only when EVERY contributing
 * layer (its own `layerId` + every `mergedFrom` layerId / messageId) is held.
 * A history message that absorbed a non-held inject (the message survived
 * the merge) follows the same rule and shows in full, attributed to the
 * absorbed layer that forced it open.
 *
 * GRAMMAR (the plan's settled shape; the base prompt `ooc.md` teaches the
 * model to read it — renames and attribute reorders are not this module's
 * to make):
 *
 *   <rp_prompt preset="…">
 *   <block id="prompt_preset_system" role="system">…text…</block>
 *   <known layer="character" role="system"/>
 *   <block id="preset_injection_…" role="user" depth="4">…text…</block>
 *   <known layer="lore" entries="Tavern, Cellar" role="system"/>
 *   <known layer="history" positions="0–39"/>
 *   <block id="prompt_preset_jailbreak" role="assistant">…text…</block>
 *   </rp_prompt>
 *
 * `id` is the payload entry's own layer id (the trace UI's survivor); a
 * history entry forced open by an absorbed inject carries that inject's
 * layer id instead. `layer` labels the held kinds (character, persona, lore,
 * summary, objective, scene, history; several kinds merged into one entry
 * join with `+`). `entries` carries the held lore layers' titles. `depth`
 * renders only for layers with a numeric `injectionDepth` (in-chat injects).
 * History placeholders carry no role (a run may mix roles) and render one
 * per contiguous run, positions compressed to `a–b` ranges (single: `a`).
 *
 * ESCAPING: the sidechat XML family's pinned sets (sidechat-xml.ts) — text
 * content escapes `& < >`; attribute values escape `& < > "`. Nothing is
 * ever truncated.
 *
 * SC-23e REUSE: this module is the ONE renderer for both arms — the preset
 * pin (SC-23c, a dry assembly of the pinned preset) and the reply-prompt
 * read (SC-23e, a stored trace's payload). Both callers map their raw
 * payload onto {@link RpPromptViewMessage} (positions included) before this
 * render; the module itself stays free of any I/O.
 */

import { PROMPT_LAYER_SOURCE_TYPE } from "@vibe-tavern/prompt-pipeline";
import { escapeXmlAttribute, escapeXmlText } from "./sidechat-xml.js";

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** One layer's attribution — the fields the view decides "held vs full" and
 *  renders `id` / `depth` from. Structural subset of the pipeline's layer and
 *  the trace DTO (both carry these fields verbatim). */
export interface RpPromptViewLayer {
	readonly id: string;
	readonly sourceType: string;
	readonly sourceId: string;
	readonly sourceName: string;
	readonly injectionDepth?: number;
}

/** One final-payload entry, position-enriched: the pipeline's payload message
 *  shape plus the branch position of each history message — the entry's own
 *  and every history message the payload's merge absorbed into it (the caller
 *  derives positions from the branch; the payload itself carries only
 *  `messageId`). `mergedFrom` lists the same-role neighbours the payload's
 *  merge squashed into this entry. */
export interface RpPromptViewMessage {
	readonly role: "system" | "user" | "assistant" | "tool";
	readonly content: string;
	readonly messageId?: string;
	readonly layerId?: string;
	readonly position?: number;
	readonly mergedFrom?: ReadonlyArray<{ messageId?: string; layerId?: string; position?: number }>;
}

/** The render input: the pinned/read preset's display name, the payload in
 *  order, its layers, and the sidechat's held lore entry ids (the entries its
 *  current active lore shows — the ONE conditionally-held kind). */
export interface RpPromptViewInput {
	readonly presetName: string;
	readonly messages: readonly RpPromptViewMessage[];
	readonly layers: readonly RpPromptViewLayer[];
	readonly heldLoreEntryIds: ReadonlySet<string>;
}

// ─── The held decision (one derivation) ─────────────────────────────────────

/** The placeholder label for a held source type (`character_system_prompt`
 *  renders as the card — the inventory's card row covers both). */
const HELD_LAYER_LABEL: Record<string, string> = {
	[PROMPT_LAYER_SOURCE_TYPE.character]: "character",
	[PROMPT_LAYER_SOURCE_TYPE.characterSystemPrompt]: "character",
	[PROMPT_LAYER_SOURCE_TYPE.persona]: "persona",
	[PROMPT_LAYER_SOURCE_TYPE.loreEntry]: "lore",
	[PROMPT_LAYER_SOURCE_TYPE.summaryMemory]: "summary",
	[PROMPT_LAYER_SOURCE_TYPE.objectiveTask]: "objective",
	[PROMPT_LAYER_SOURCE_TYPE.objectiveLongTerm]: "objective",
	[PROMPT_LAYER_SOURCE_TYPE.sceneState]: "scene",
	[PROMPT_LAYER_SOURCE_TYPE.chatHistory]: "history",
};

/** Is a layer of this source type held by the sidechat? Lore is conditional
 *  (held iff the same entry is in the sidechat's active lore); everything
 *  unknown defaults to NOT held — shown in full, never guessed at. */
function isHeldLayer(
	layer: RpPromptViewLayer,
	heldLoreEntryIds: ReadonlySet<string>,
): boolean {
	if (layer.sourceType === PROMPT_LAYER_SOURCE_TYPE.loreEntry) {
		return heldLoreEntryIds.has(layer.sourceId);
	}
	return layer.sourceType in HELD_LAYER_LABEL;
}

// ─── The renderer ───────────────────────────────────────────────────────────

/** Render the `<rp_prompt>` view. Null when the payload carries no messages
 *  (the caller omits the section — the sidechat-xml null convention). */
export function renderRpPromptView(input: RpPromptViewInput): string | null {
	if (input.messages.length === 0) return null;

	const layersById = new Map<string, RpPromptViewLayer>();
	for (const layer of input.layers) layersById.set(layer.id, layer);

	const lines: string[] = [`<rp_prompt preset="${escapeXmlAttribute(input.presetName)}">`];

	/** History-entry accumulator: the entries of the current contiguous run
	 *  and the positions they cover; flushed as ONE placeholder before any
	 *  non-history entry and at the end. */
	let historyRunEntries: RpPromptViewMessage[] = [];
	const flushHistoryRun = () => {
		if (historyRunEntries.length === 0) return;
		const positions = historyRunEntries.flatMap(entryPositions);
		lines.push(`<known layer="history"${positions.length > 0 ? ` positions="${escapeXmlAttribute(formatPositionRanges(positions))}"` : ""}/>`);
		historyRunEntries = [];
	};

	for (const entry of input.messages) {
		if (entry.layerId === undefined) {
			// A history payload entry (messageId — or a message that survived
			// a merge with an inject; the open-check below still applies).
			const absorbedLayers = (entry.mergedFrom ?? []).flatMap((ref) =>
				ref.layerId !== undefined ? [ref.layerId] : [],
			);
			const forcing = absorbedLayers.map((id) => layersById.get(id)).find(
				(layer): layer is RpPromptViewLayer =>
					layer !== undefined && !isHeldLayer(layer, input.heldLoreEntryIds),
			);
			if (forcing === undefined) {
				historyRunEntries.push(entry);
				continue;
			}
			// A non-held inject was merged INTO this history message — the
			// merged text shows in full, attributed to the absorbed inject.
			flushHistoryRun();
			lines.push(renderBlock(forcing.id, entry.role, forcing, entry.content));
			continue;
		}

		flushHistoryRun();
		const layer = layersById.get(entry.layerId);
		if (layer === undefined) {
			// An entry whose layer is not in the layer list cannot be judged
			// held — show it in full under its own id, never dropped.
			lines.push(renderBlock(entry.layerId, entry.role, undefined, entry.content));
			continue;
		}
		// Contributing layers: the entry's own plus every same-role layer the
		// payload's merge absorbed into it (the trace UI's mergedFrom refs).
		const contributing: RpPromptViewLayer[] = [layer];
		for (const ref of entry.mergedFrom ?? []) {
			if (ref.layerId === undefined) continue;
			const absorbed = layersById.get(ref.layerId);
			if (absorbed !== undefined) contributing.push(absorbed);
		}
		if (contributing.every((l) => isHeldLayer(l, input.heldLoreEntryIds))) {
			lines.push(renderKnownPlaceholder(contributing, entry.role, input.heldLoreEntryIds));
			continue;
		}
		lines.push(renderBlock(layer.id, entry.role, layer, entry.content));
	}
	flushHistoryRun();

	lines.push("</rp_prompt>");
	return lines.join("\n");
}

// ─── Entry renderers ────────────────────────────────────────────────────────

/** A full entry: the payload text verbatim, the entry's role, `depth` only
 *  for in-chat injects (a layer with a numeric injectionDepth). */
function renderBlock(
	id: string,
	role: RpPromptViewMessage["role"],
	layer: RpPromptViewLayer | undefined,
	content: string,
): string {
	const depth = layer?.injectionDepth;
	return `<block id="${escapeXmlAttribute(id)}" role="${role}"${
		typeof depth === "number" ? ` depth="${depth}"` : ""
	}>${escapeXmlText(content)}</block>`;
}

/** A placeholder for an entry every contributing layer of which is held:
 *  the held kinds joined with `+` (in contribution order), the held lore
 *  layers' titles in `entries`, the role kept. */
function renderKnownPlaceholder(
	contributing: readonly RpPromptViewLayer[],
	role: RpPromptViewMessage["role"],
	heldLoreEntryIds: ReadonlySet<string>,
): string {
	const labels: string[] = [];
	const loreTitles: string[] = [];
	for (const layer of contributing) {
		const label = HELD_LAYER_LABEL[layer.sourceType];
		if (label === undefined) continue; // unreachable: held ⇒ known type
		if (!labels.includes(label)) labels.push(label);
		if (
			layer.sourceType === PROMPT_LAYER_SOURCE_TYPE.loreEntry
			&& heldLoreEntryIds.has(layer.sourceId)
		) {
			loreTitles.push(layer.sourceName);
		}
	}
	const entries = loreTitles.length > 0 ? ` entries="${escapeXmlAttribute(loreTitles.join(", "))}"` : "";
	return `<known layer="${escapeXmlAttribute(labels.join("+"))}"${entries} role="${role}"/>`;
}

// ─── Positions ───────────────────────────────────────────────────────────────

/** The branch positions one history payload entry covers: its own plus the
 *  position of every history message the payload's merge absorbed into it
 *  (both enriched by the caller — the payload itself carries only ids). A ref
 *  without a position contributes nothing; a position is never invented. */
function entryPositions(entry: RpPromptViewMessage): number[] {
	const positions: number[] = [];
	if (entry.position !== undefined) positions.push(entry.position);
	for (const ref of entry.mergedFrom ?? []) {
		if (ref.position !== undefined) positions.push(ref.position);
	}
	return positions;
}

/** Compress sorted positions into `a–b` ranges (single: `a`; gaps: `, `). */
function formatPositionRanges(positions: readonly number[]): string {
	const sorted = [...new Set(positions)].sort((a, b) => a - b);
	const parts: string[] = [];
	let start = sorted[0];
	let prev = sorted[0];
	for (const position of sorted.slice(1)) {
		if (position === prev + 1) {
			prev = position;
			continue;
		}
		parts.push(start === prev ? `${start}` : `${start}–${prev}`);
		start = position;
		prev = position;
	}
	if (sorted.length > 0) parts.push(start === prev ? `${start}` : `${start}–${prev}`);
	return parts.join(", ");
}
