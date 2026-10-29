/**
 * The sidechat timeline's frozen-payload parsers (SIDECHAT_PLAN SC-3b; extracted
 * from `sidechat-context.ts` when the arch-gate's 800-line cap caught that
 * file's growth — DR-4b, extraction-only, byte-identical code). One merged
 * timeline EVENT row (SC-1) maps onto the renderer's entry type here, with
 * every known kind's payload structurally validated: a payload that does not
 * match its kind's frozen shape THROWS (the renderer's exhaustiveness guard
 * covers unknown kinds — corrupt payloads of known kinds surface here instead,
 * never silently pre-filtered).
 *
 * Consumed by the context loader's timeline walk AND, since SC-8c, by the
 * sidechat compaction service (the SAME validation + refusal path renders the
 * summarizer transcript's reference events — one derivation). The loader
 * re-exports {@link mapTimelineEvent} so existing import paths are unchanged.
 */

import { isRecord } from "@vibe-tavern/domain";
import type { AgentThreadContextEvent } from "@vibe-tavern/db";
import type { RpSyncPayload, RpVariantSelection, SelectionChangedPayload } from "./rp-sync.js";
import type {
	BranchForkedPayload,
	SidechatTimelineEvent,
	VariantsAttachedPayload,
} from "./sidechat-xml.js";
import type { ProfileChangedPayload } from "./sidechat-profile-change.js";

// ─── Timeline (frozen payloads → SC-3a input types) ──────────────────────────

/** Corrupt-payload refusal: a known kind whose stored payload does not match
 *  its frozen shape. Throwing (not skipping) is the contract — silently
 *  dropping an event would change what the model is shown. */
function corrupt(threadId: string, kind: string, seq: number | null, detail: string): never {
	throw new Error(
		`loadSidechatContext: thread ${threadId} event ${kind} (seq ${seq ?? "none"}) payload is not the frozen shape (${detail}) — refusing to render corrupted frozen context`,
	);
}

/** The `profile_changed` row as mapped — user-feed provenance that never
 *  renders for the model (no renderer-union member): the events route serves
 *  it, while the context loader and the compaction service filter it out.
 *  Kept OUT of `SidechatTimelineEvent` on purpose — that union feeds the
 *  model-facing tag grammar (the owner's settled contract), and a profile
 *  switch is not RP context. */
export interface ProfileChangedTimelineEvent {
	readonly rowType: "event";
	readonly kind: "profile_changed";
	readonly payload: ProfileChangedPayload;
}

/** Everything `mapTimelineEvent` can return — the renderer's events plus the
 *  one feed-only kind. Model-facing consumers (the loader walk, the
 *  compaction transcript) must handle `profile_changed` by SKIPPING it; the
 *  events route serves it onto the wire. */
export type MappedAgentTimelineEvent = SidechatTimelineEvent | ProfileChangedTimelineEvent;

/** Map one merged-timeline EVENT row (SC-1) onto the renderer's entry type.
 * `where` names the row in every parser's refusal message. The `rp_sync`
 * case only PARSES — the walk routes that kind through SC-6's coverage
 * (its batch is split per message by summary coverage) before rendering.
 * Exported since SC-8c: the sidechat compaction service maps the SAME
 * frozen rows (through the SAME validation + refusal path) when it renders
 * the summarizer transcript's reference events — one derivation. DR-12
 * adds the `profile_changed` arm (feed-only — see
 * {@link ProfileChangedTimelineEvent}). */
export function mapTimelineEvent(threadId: string, entry: AgentThreadContextEvent): MappedAgentTimelineEvent {
	const where = { threadId, kind: entry.kind, seq: entry.seq };
	switch (entry.kind) {
		case "rp_sync":
			return { rowType: "event", kind: "rp_sync", payload: parseRpSyncPayload(where, entry.payload) };
		case "variants_attached":
			return {
				rowType: "event",
				kind: "variants_attached",
				payload: parseVariantsAttachedPayload(where, entry.payload),
			};
		case "selection_changed":
			return {
				rowType: "event",
				kind: "selection_changed",
				payload: parseSelectionChangedPayload(where, entry.payload),
			};
		case "branch_forked":
			return { rowType: "event", kind: "branch_forked", payload: parseBranchForkedPayload(where, entry.payload) };
		case "profile_changed":
			return {
				rowType: "event",
				kind: "profile_changed",
				payload: parseProfileChangedPayload(where, entry.payload),
			};
	}
	// No default: the store's kind union is closed. A new kind makes this
	// switch non-exhaustive at compile time — teach this mapper before writing
	// that kind.
}

interface EventWhere {
	threadId: string;
	kind: string;
	seq: number | null;
}

function parseRpSyncPayload(where: EventWhere, payload: unknown): RpSyncPayload {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) {
		corrupt(where.threadId, where.kind, where.seq, "messages array missing");
	}
	const messages = payload.messages.map((raw: unknown): RpSyncPayload["messages"][number] => {
		if (!isRecord(raw)) corrupt(where.threadId, where.kind, where.seq, "message row is not a record");
		const id = raw.id;
		const position = raw.position;
		const role = raw.role;
		const authorName = raw.authorName ?? null;
		const variantId = raw.variantId ?? null;
		const model = raw.model ?? null;
		const preset = raw.preset ?? null;
		const text = raw.text;
		if (typeof id !== "string" || typeof position !== "number" || typeof text !== "string") {
			corrupt(where.threadId, where.kind, where.seq, "message id/position/text not strings/number");
		}
		if (
			role !== "system" && role !== "user" && role !== "assistant" && role !== "tool"
		) {
			corrupt(where.threadId, where.kind, where.seq, `unknown message role "${String(role)}"`);
		}
		if (authorName !== null && typeof authorName !== "string") {
			corrupt(where.threadId, where.kind, where.seq, "authorName is neither string nor null");
		}
		if (variantId !== null && typeof variantId !== "string") {
			corrupt(where.threadId, where.kind, where.seq, "variantId is neither string nor null");
		}
		if (model !== null && typeof model !== "string") {
			corrupt(where.threadId, where.kind, where.seq, "model is neither string nor null");
		}
		if (preset !== null && typeof preset !== "string") {
			corrupt(where.threadId, where.kind, where.seq, "preset is neither string nor null");
		}
		return { id, position, role, authorName, variantId, model, preset, text };
	});
	const fromPosition = payload.fromPosition;
	const toPosition = payload.toPosition;
	if (typeof fromPosition !== "number" || typeof toPosition !== "number") {
		corrupt(where.threadId, where.kind, where.seq, "fromPosition/toPosition not numbers");
	}
	return { fromPosition, toPosition, messages };
}

function parseVariantsAttachedPayload(where: EventWhere, payload: unknown): VariantsAttachedPayload {
	if (!isRecord(payload) || typeof payload.position !== "number" || !Array.isArray(payload.variants)) {
		corrupt(where.threadId, where.kind, where.seq, "position/variants missing");
	}
	const variants = payload.variants.map((raw: unknown): VariantsAttachedPayload["variants"][number] => {
		if (!isRecord(raw) || typeof raw.text !== "string" || typeof raw.selected !== "boolean") {
			corrupt(where.threadId, where.kind, where.seq, "variant text/selected missing");
		}
		// SC-23a provenance — absent on events frozen before the unit, so
		// each normalizes to null (the attribute renders only when non-null).
		const number = raw.number ?? null;
		const model = raw.model ?? null;
		const preset = raw.preset ?? null;
		if (number !== null && typeof number !== "number") {
			corrupt(where.threadId, where.kind, where.seq, "variant number is neither number nor null");
		}
		if (model !== null && typeof model !== "string") {
			corrupt(where.threadId, where.kind, where.seq, "variant model is neither string nor null");
		}
		if (preset !== null && typeof preset !== "string") {
			corrupt(where.threadId, where.kind, where.seq, "variant preset is neither string nor null");
		}
		return { text: raw.text, selected: raw.selected, number, model, preset };
	});
	return { position: payload.position, variants };
}

function parseSelectionChangedPayload(where: EventWhere, payload: unknown): SelectionChangedPayload {
	if (!isRecord(payload) || typeof payload.messageId !== "string" || typeof payload.position !== "number") {
		corrupt(where.threadId, where.kind, where.seq, "messageId/position missing");
	}
	return {
		messageId: payload.messageId,
		position: payload.position,
		previous: parseVariantSelection(where, payload.previous),
		current: parseVariantSelection(where, payload.current),
	};
}

function parseVariantSelection(where: EventWhere, raw: unknown): RpVariantSelection {
	if (!isRecord(raw) || typeof raw.variantId !== "string" || typeof raw.text !== "string") {
		corrupt(where.threadId, where.kind, where.seq, "previous/current variant pair missing");
	}
	// SC-23a provenance — absent on events frozen before the unit → null.
	const model = raw.model ?? null;
	const preset = raw.preset ?? null;
	if (model !== null && typeof model !== "string") {
		corrupt(where.threadId, where.kind, where.seq, "previous/current model is neither string nor null");
	}
	if (preset !== null && typeof preset !== "string") {
		corrupt(where.threadId, where.kind, where.seq, "previous/current preset is neither string nor null");
	}
	return { variantId: raw.variantId, text: raw.text, model, preset };
}

function parseBranchForkedPayload(where: EventWhere, payload: unknown): BranchForkedPayload {
	if (!isRecord(payload) || typeof payload.at !== "number") {
		corrupt(where.threadId, where.kind, where.seq, "at missing");
	}
	return { at: payload.at };
}

/** The parked/frozen from-to pair of a profile switch (DR-12) — both sides
 *  carry the profile id and the write-time display name. */
function parseProfileChangedPayload(where: EventWhere, payload: unknown): ProfileChangedPayload {
	function side(which: "from" | "to"): { id: string; name: string } {
		const raw = isRecord(payload) ? payload[which] : undefined;
		if (
			!isRecord(raw) ||
			typeof raw.id !== "string" ||
			typeof raw.name !== "string"
		) {
			corrupt(where.threadId, where.kind, where.seq, `${which} id/name missing`);
		}
		return { id: raw.id, name: raw.name };
	}
	return { from: side("from"), to: side("to") };
}
