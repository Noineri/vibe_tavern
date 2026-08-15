/**
 * ER-9 — Experience-Copilot turn aggregation (pure).
 *
 * Aggregates an experience-copilot turn's tool activities (from the ephemeral
 * turn store, ER-8) into a {@link ExperienceCopilotProposal}: the last proposed
 * text per named buffer (`rules`, `visual`), plus the model's per-tool
 * summaries in call order. Consumed by the editor review flow (CD-2/CD-6):
 * the review hook aggregates the live turn, the editor panel diffs the
 * proposal against the turn-start snapshot, and accepts write through
 * mergeSelectedBody into the draft buffers (the old chat-side Apply patch —
 * `buildExperienceCopilotApplyPatch`, an identity function once hunk
 * selection moved into the editor — was removed in CD-7).
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
	/** Per-tool summaries in call order (the model's explanations, shown in the review bar). */
	summaries: string[];
}

/**
 * Keep only finalized (done) activities that actually propose a buffer,
 * deduped by toolCallId (the store merges re-emits in place).
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
