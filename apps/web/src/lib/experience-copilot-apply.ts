/**
 * ER-9 — Experience-Copilot turn aggregation (pure).
 *
 * Aggregates an experience-copilot turn's tool activities (from the ephemeral
 * turn store, ER-8) into the two shapes the apply flow needs:
 *   1. `proposal` — an {@link ExperienceCopilotProposal} carrying the last
 *      proposed text per named buffer (`rules`, `visual`), plus the model's
 *      per-tool summaries (shown above Apply, in call order).
 *   2. `applyPatch` — an {@link ExperienceCopilotApplyPatch} that the draft
 *      stores consume on commit (NOT a backend RPC).
 *
 * This is an ADAPTATION-WITH-SIMPLIFICATION of `coauthor-apply-aggregate.ts`:
 * the copilot has two PLAIN-TEXT buffers (`rules`, `visual`) and nothing else.
 * There is no profile.md (so no parse/serialize round-trip and no frontmatter
 * rebuild), no greetings (no index/add slots), no lore bundle, and no
 * `BuildCharacterDraft` — the canonical buffer text comes from the draft stores
 * at diff-build time in Wave 4, not from this module. Aggregation is therefore
 * just last-proposal-wins per buffer over the `{ target, proposed, summary }`
 * tool-output triple.
 *
 * Pure: no I/O, no React, no store reads. Takes the turn's activities as input.
 * Tested in isolation (the two-buffer last-wins semantics are the load-bearing
 * contract the Wave 4 Apply flow consumes).
 */
import type { ExperienceCopilotToolActivity } from "../stores/experience-copilot-turn-store.js";

/** A finalized, proposal-producing activity (rules or visual buffer). */
interface ProposedActivity {
	toolCallId: string;
	target: "rules" | "visual";
	proposed: string;
	summary?: string;
}

/** The result of aggregating a turn's activities over the two buffers. */
export interface ExperienceCopilotProposal {
	/** True iff at least one activity produced a proposal. */
	hasProposal: boolean;
	/** Last rules-target proposal text (undefined if none proposed this turn). */
	proposedRules?: string;
	/** Last visual-target proposal text (undefined if none proposed this turn). */
	proposedVisual?: string;
	/** Per-tool summaries in call order (the model's explanations, shown above Apply). */
	summaries: string[];
}

/** The draft-store patch (NOT a backend RPC): only buffers that were proposed.
 *  Wave 4 writes `rules` → the script draft store, `visual` → the visual draft store. */
export interface ExperienceCopilotApplyPatch {
	rules?: string;
	visual?: string;
}

/**
 * Reduce the raw activities to the finalized, proposal-producing ones. A
 * `streaming` placeholder (no `proposed` yet) or an `error` is excluded — only
 * `done` activities with a `target` and non-empty `proposed` count. This also
 * naturally excludes the read-only tools (`read_skill_file` carries `readPath`;
 * `run_test`/`run_simulate`/`suggest_visual_binding` carry only a `summary`),
 * which never propose a buffer edit. Deduped by `toolCallId` (later wins,
 * mirroring the store's upsert-merge semantics).
 */
function finalizedActivities(activities: ReadonlyArray<ExperienceCopilotToolActivity>): ProposedActivity[] {
	const byId = new Map<string, ProposedActivity>();
	for (const a of activities) {
		if (a.status !== "done") continue;
		if (!a.target || !a.proposed) continue;
		byId.set(a.toolCallId, {
			toolCallId: a.toolCallId,
			target: a.target,
			proposed: a.proposed,
			summary: a.summary,
		});
	}
	// Preserve call order (Map iteration is insertion order, which matches the
	// store's append-then-merge-in-place → stable chronological order).
	return [...byId.values()];
}

/**
 * Aggregate a turn's activities into a proposal over the two named buffers.
 * Last-proposal-wins per buffer: the model may revise mid-turn, so the later
 * `proposed` text is more coherent and already carries every earlier op (each
 * `write_buffer`/`edit_buffer` result is the complete cumulative buffer).
 */
export function aggregateExperienceCopilotProposal(
	activities: ReadonlyArray<ExperienceCopilotToolActivity>,
): ExperienceCopilotProposal {
	const finalized = finalizedActivities(activities);
	const summaries = finalized.map((a) => a.summary).filter((s): s is string => typeof s === "string" && s.length > 0);

	if (finalized.length === 0) {
		return { hasProposal: false, summaries: [] };
	}

	let proposedRules: string | undefined;
	for (const a of finalized) {
		if (a.target === "rules") proposedRules = a.proposed;
	}

	let proposedVisual: string | undefined;
	for (const a of finalized) {
		if (a.target === "visual") proposedVisual = a.proposed;
	}

	return {
		hasProposal: true,
		...(proposedRules !== undefined ? { proposedRules } : {}),
		...(proposedVisual !== undefined ? { proposedVisual } : {}),
		summaries,
	};
}

/**
 * Rebuild the draft-store patch from a hunk-level (partial) selection.
 *
 * `merged` is the patch whose values came from the user's selected hunks (the
 * reviewing diff hybrid); `base` is the wholesale proposal from
 * {@link aggregateExperienceCopilotProposal} and tells us WHICH buffers were
 * proposed (so we don't send buffers the model never touched). The merged text
 * IS the patch value — copilot buffers are plain text, with no frontmatter
 * rebuild like co-author's profile.md.
 *
 * Pure: no I/O, no React, no store reads.
 */
export function buildExperienceCopilotApplyPatch(
	merged: ExperienceCopilotApplyPatch,
	base: ExperienceCopilotProposal,
): ExperienceCopilotApplyPatch {
	const patch: ExperienceCopilotApplyPatch = {};
	if (base.proposedRules !== undefined) patch.rules = merged.rules;
	if (base.proposedVisual !== undefined) patch.visual = merged.visual;
	return patch;
}
