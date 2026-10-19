/**
 * Sidechat XML renderers (SIDECHAT_PLAN SC-3a) — PURE: plain inputs in, XML
 * strings out. No store reads or writes, no db import, no logger, clock, or
 * randomness; nothing is ever truncated. The context assembler (SC-3b) owns
 * what enters each renderer and drops the nulls these return.
 *
 * TAG GRAMMAR (the owner's settled contract from the plan; the base prompt
 * (SC-4a) describes exactly these tags to the model — renames, attribute
 * reorders, and added/dropped wrappers are not this module's to make):
 *
 *   <character name="…">full card</character>
 *   <persona name="…" pronouns="…">…</persona>
 *   <active_lore>
 *   <lore_entry title="…">…</lore_entry>            (one per entry)
 *   </active_lore>
 *   <objectives mode="route|goals">…</objectives>
 *   <current_scene>…</current_scene>
 *   <rp_sync from="a" to="b">
 *   <rp_message position="n" role="assistant|user" author="…">text</rp_message>
 *   </rp_sync>
 *   <rp_selection_changed position="n">
 *   <previous>…</previous>
 *   <current>…</current>
 *   </rp_selection_changed>
 *   <rp_variants position="n">
 *   <variant selected="true|false">…</variant>
 *   </rp_variants>
 *   <rp_branch_forked at="n"/>
 *   <rp_summary from="a" to="b">…</rp_summary>
 *
 * `rp_message` text is the FROZEN model-view text (SC-2a) — it already
 * carries the dice and mini-app report blocks in the RP prompt's wording, so
 * there are no separate dice tags here.
 *
 * ESCAPING: text content escapes `& < >`; attribute values escape `& < > "`.
 * The prompt-pipeline `escapeXml` escapes a fifth entity (`'` → `&apos;`)
 * beyond this unit's pinned set, so this module keeps its own two one-line
 * helpers instead of reusing it (an apostrophe in user text stays literal).
 *
 * EMPTY SECTIONS: every section renderer returns `string | null`, and null
 * means "omit" — an empty tag is never emitted; SC-3b drops the nulls.
 * Emptiness is exact (`=== ""` / empty list): whitespace-only content is
 * content. The one attribute-level exception: `persona` renders its
 * `pronouns` attribute ONLY when the value exists (an empty `pronouns=""`
 * would carry no information; the tag itself still renders when the text is
 * non-empty). `rp_message`'s `author` is the opposite: the grammar pins a
 * fixed three-attribute shape, so a null authorName renders as `author=""`.
 *
 * TIMELINE ORDER: renderTimelineSection takes the merged listTimeline EVENT
 * list (SC-1: seq ascending, NULL-seq rows first) AS GIVEN and renders it in
 * order — it never re-sorts. Interleaving events with messages by `seq` is
 * the store's listTimeline contract; SC-4d's flow builder consumes that
 * merged order and does not re-derive it.
 *
 * WRITERS NOT YET LANDED: `variants_attached` (SC-20), `branch_forked`
 * (SC-20), and `rp_summary` (SC-6) have no store writers yet — their input
 * payload types below are defined per the inventory semantics, and this
 * renderer renders ALL kinds regardless.
 *
 * TIMELINE IS EVENTS-ONLY (SC-4d, variant A): the renderer no longer renders
 * OOC message rows — the sidechat's own conversation reaches the model
 * exactly once, as the real history messages of the turn (SC-4b's flow), and
 * each frozen event rides that same flow as its own user-role message body
 * (renderTimelineEvent). Which events enter the flow is the loader's (SC-3b)
 * choice, not this module's — every entry given is rendered as-is.
 */

import type { RpSyncPayload, SelectionChangedPayload } from "./rp-sync.js";

// ─── Escaping (pinned sets — see module doc) ────────────────────────────────

/** Escape TEXT content: `& < >` (this unit's pinned set — nothing else). */
function escapeXmlText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Escape an ATTRIBUTE value: the text set plus `"`. */
function escapeXmlAttribute(value: string): string {
	return escapeXmlText(value).replaceAll('"', "&quot;");
}

// ─── Section inputs ──────────────────────────────────────────────────────────

/** The character section input: display name + the full card text. */
export interface CharacterSectionInput {
	readonly name: string;
	readonly card: string;
}

/** The persona section input: display name, optional pronouns, text. */
export interface PersonaSectionInput {
	readonly name: string;
	readonly pronouns: string | null;
	readonly text: string;
}

/** One lore entry: its title and text. */
export interface LoreEntryInput {
	readonly title: string;
	readonly text: string;
}

/** The objectives section input: which mode the chat shows + the text. */
export interface ObjectivesSectionInput {
	readonly mode: "route" | "goals";
	readonly text: string;
}

// ─── Event payload inputs (kinds with no writers yet) ───────────────────────

/**
 * `variants_attached` payload — an alternative variant attached to a message.
 * The renderer's input shape per the inventory: each variant carries its own
 * `selected` flag (the alternatives render `selected="false"`, the chosen one
 * `selected="true"`). The STORED payload shape is owned by the future writer
 * (SC-20); SC-3b maps it onto this input.
 */
export interface VariantsAttachedPayload {
	readonly position: number;
	readonly variants: readonly { readonly text: string; readonly selected: boolean }[];
}

/** `branch_forked` payload — the message position the fork happened at
 *  (rendered as the self-closing `<rp_branch_forked at="n"/>`). Writer lands
 *  in SC-20; SC-3b maps the stored payload onto this input. */
export interface BranchForkedPayload {
	readonly at: number;
}

/** `rp_summary` payload — the summarized position bracket plus the summary
 *  text (rendered as `<rp_summary from="a" to="b">…</rp_summary>`). Field
 *  names mirror RpSyncPayload's bracket on purpose. Writer lands in SC-6;
 *  SC-3b maps the stored payload onto this input. */
export interface RpSummaryPayload {
	readonly fromPosition: number;
	readonly toPosition: number;
	readonly text: string;
}

// ─── Timeline (frozen events; events-only since SC-4d) ──────────────────────

/**
 * The renderer's plain projection of a listTimeline EVENT row (SC-1): the
 * event kind plus its kind-specific payload. `rp_sync` and `selection_changed`
 * payloads are SC-2b's frozen shapes imported verbatim; the other three are
 * defined above (writers land in SC-6/SC-20).
 */
export type SidechatTimelineEvent =
	| { readonly rowType: "event"; readonly kind: "rp_sync"; readonly payload: RpSyncPayload }
	| { readonly rowType: "event"; readonly kind: "variants_attached"; readonly payload: VariantsAttachedPayload }
	| { readonly rowType: "event"; readonly kind: "selection_changed"; readonly payload: SelectionChangedPayload }
	| { readonly rowType: "event"; readonly kind: "branch_forked"; readonly payload: BranchForkedPayload }
	| { readonly rowType: "event"; readonly kind: "rp_summary"; readonly payload: RpSummaryPayload };

// ─── Section renderers ───────────────────────────────────────────────────────

/** Render `<character name="…">full card</character>`; null when the card is
 *  empty (a name alone is not a section). */
export function renderCharacterSection(input: CharacterSectionInput): string | null {
	if (input.card === "") return null;
	return `<character name="${escapeXmlAttribute(input.name)}">${escapeXmlText(input.card)}</character>`;
}

/** Render `<persona name="…" pronouns="…">…</persona>`; null when the text
 *  is empty. The `pronouns` attribute renders only when the value exists
 *  (see module doc — the one attribute-level omission). */
export function renderPersonaSection(input: PersonaSectionInput): string | null {
	if (input.text === "") return null;
	const pronouns =
		input.pronouns !== null && input.pronouns !== ""
			? ` pronouns="${escapeXmlAttribute(input.pronouns)}"`
			: "";
	return `<persona name="${escapeXmlAttribute(input.name)}"${pronouns}>${escapeXmlText(input.text)}</persona>`;
}

/** Render `<active_lore>` with one `<lore_entry title="…">…</lore_entry>`
 *  per entry; null when the list is empty. */
export function renderLoreSection(entries: readonly LoreEntryInput[]): string | null {
	if (entries.length === 0) return null;
	const lines = entries.map(
		(entry) => `<lore_entry title="${escapeXmlAttribute(entry.title)}">${escapeXmlText(entry.text)}</lore_entry>`,
	);
	return ["<active_lore>", ...lines, "</active_lore>"].join("\n");
}

/** Render `<objectives mode="route|goals">…</objectives>`; null when the
 *  text is empty. */
export function renderObjectivesSection(input: ObjectivesSectionInput): string | null {
	if (input.text === "") return null;
	return `<objectives mode="${input.mode}">${escapeXmlText(input.text)}</objectives>`;
}

/** Render `<current_scene>…</current_scene>`; null when the text is empty. */
export function renderCurrentSceneSection(text: string): string | null {
	if (text === "") return null;
	return `<current_scene>${escapeXmlText(text)}</current_scene>`;
}

// ─── Timeline renderer ───────────────────────────────────────────────────────

/**
 * Render the merged timeline's frozen events as their XML tags, joined with
 * `\n`; null when the list is empty. EVENTS ONLY since SC-4d (variant A):
 * OOC message rows no longer render here — the sidechat's own conversation
 * rides the turn's message flow as the real history messages, exactly once.
 * The list is rendered AS GIVEN, in order — the store's listTimeline owns
 * the seq interleaving; this function never re-sorts.
 */
export function renderTimelineSection(entries: readonly SidechatTimelineEvent[]): string | null {
	if (entries.length === 0) return null;
	return entries.map(renderTimelineEvent).join("\n");
}

/**
 * Render ONE frozen event as its XML tag block — the body of that event's
 * user-role message in the turn's message flow (SC-4d). The same per-event
 * renderer the timeline section renders with: tags and escaping unchanged,
 * no wrapper prose. An input outside the event union (a message row, an
 * unknown kind) THROWS rather than silently dropping or re-shaping it —
 * either would change what the model is shown.
 */
export function renderTimelineEvent(entry: SidechatTimelineEvent): string {
	switch (entry.kind) {
		case "rp_sync":
			return renderRpSyncEvent(entry.payload);
		case "variants_attached":
			return renderVariantsAttachedEvent(entry.payload);
		case "selection_changed":
			return renderSelectionChangedEvent(entry.payload);
		case "branch_forked":
			return renderBranchForkedEvent(entry.payload);
		case "rp_summary":
			return renderRpSummaryEvent(entry.payload);
		default: {
			// Exhaustiveness guard: the union above is closed, so this is
			// unreachable for typed callers — but a runtime kind outside it
			// means a new event kind exists without this renderer knowing it,
			// and silently dropping it would change what the model is shown.
			const kind: string = (entry as { kind: string }).kind;
			throw new Error(
				`renderTimelineSection: unknown timeline event kind "${kind}" — ` +
					"teach the renderer before writing that kind",
			);
		}
	}
}

function renderRpSyncEvent(payload: RpSyncPayload): string {
	const messages = payload.messages.map(
		(message) =>
			`<rp_message position="${message.position}" role="${escapeXmlAttribute(message.role)}" ` +
			`author="${escapeXmlAttribute(message.authorName ?? "")}">${escapeXmlText(message.text)}</rp_message>`,
	);
	return [`<rp_sync from="${payload.fromPosition}" to="${payload.toPosition}">`, ...messages, "</rp_sync>"].join(
		"\n",
	);
}

function renderVariantsAttachedEvent(payload: VariantsAttachedPayload): string {
	const variants = payload.variants.map(
		(variant) => `<variant selected="${variant.selected ? "true" : "false"}">${escapeXmlText(variant.text)}</variant>`,
	);
	return [`<rp_variants position="${payload.position}">`, ...variants, "</rp_variants>"].join("\n");
}

function renderSelectionChangedEvent(payload: SelectionChangedPayload): string {
	return [
		`<rp_selection_changed position="${payload.position}">`,
		`<previous>${escapeXmlText(payload.previous.text)}</previous>`,
		`<current>${escapeXmlText(payload.current.text)}</current>`,
		"</rp_selection_changed>",
	].join("\n");
}

function renderBranchForkedEvent(payload: BranchForkedPayload): string {
	return `<rp_branch_forked at="${payload.at}"/>`;
}

function renderRpSummaryEvent(payload: RpSummaryPayload): string {
	return `<rp_summary from="${payload.fromPosition}" to="${payload.toPosition}">${escapeXmlText(
		payload.text,
	)}</rp_summary>`;
}
