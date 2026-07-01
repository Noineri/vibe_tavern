/**
 * CA-11 — Co-Author turn aggregation (pure).
 *
 * Aggregates a co-author turn's tool activities (from the ephemeral turn store,
 * CA-9.2) into the two shapes CA-11 needs:
 *   1. `proposedDraft` — a `BuildCharacterDraft` whose `draftToBody` emission is
 *      the PROPOSED document, used to build the reviewing diff
 *      (canonical body → proposed body).
 *   2. `applyRequest` — a `CoauthorApplyRequest` sent to the CA-7 Apply RPC.
 *
 * WHY THE DIFF IS IN BODY SPACE (not profile.md). The `edit_profile` tool's
 * `proposed` is a full canonical `profile.md` (frontmatter + the three prose
 * H1s). But the canonical `profile.md` of the CURRENT card cannot be rebuilt
 * faithfully on the frontend: `creator` / `character_version` live in
 * `extensions`, which the snapshot `AppCharacter` does not carry (they are only
 * recoverable from the V3 export JSON). So a profile.md-vs-profile.md diff
 * would show SPURIOUS frontmatter deltas for those fields. Diffing in BODY
 * space avoids this: the body carries only PERSONALITY/SCENARIO/EXAMPLES/
 * GREETINGS — exactly what the live editor shows, and exactly what the user can
 * review. Frontmatter-only deltas (e.g. a rename) are still applied via the
 * full `profileMd` on Apply; they are surfaced to the user through the tool
 * `summary`(s) rather than the body diff. This is a documented V1 limitation.
 *
 * Pure: no I/O, no React, no store reads. Takes the activities + the current
 * draft as inputs. Tested in isolation (the Apply REQUEST shape is the
 * load-bearing contract with the CA-7 backend).
 */
import { parseProfileMd, serializeProfileMd } from "@vibe-tavern/db/codecs";
import type { BuildCharacterDraft, CoauthorApplyRequest } from "@vibe-tavern/api-contracts";
import type { CoauthorToolActivity } from "../stores/coauthor-turn-store.js";
import { pinBodyFields, pinGreetingsFields } from "../components/build/editors/vibe-md-sync.js";

/** A finalized, proposed-producing activity (streaming/error ones are excluded). */
interface ProposedActivity {
	toolCallId: string;
	target: "profile" | "greeting";
	proposed: string;
	summary?: string;
	greetingIndex?: number;
	isAdd?: boolean;
}

/** The result of aggregating a turn's activities. */
export interface CoauthorProposal {
	/** True iff at least one activity produced a proposal (else nothing to review). */
	hasProposal: boolean;
	/** Draft whose `draftToBody` is the proposed document (for the diff). */
	proposedDraft: BuildCharacterDraft;
	/** Apply request — only fields that were actually proposed (partial applies ok). */
	applyRequest: CoauthorApplyRequest;
	/** The model's per-tool summaries (shown above Apply, in call order). */
	summaries: string[];
}

/**
 * Reduce the raw activities to the finalized, proposed-producing ones. A
 * `streaming` placeholder (no `proposed` yet) or an `error` is excluded — only
 * `done` activities with a `target` and non-empty `proposed` count. Deduped by
 * `toolCallId` (later wins, mirroring the store's upsert-merge semantics).
 */
function finalizedActivities(activities: CoauthorToolActivity[]): ProposedActivity[] {
	const byId = new Map<string, ProposedActivity>();
	for (const a of activities) {
		if (a.status !== "done" || !a.target || !a.proposed) continue;
		byId.set(a.toolCallId, {
			toolCallId: a.toolCallId,
			target: a.target,
			proposed: a.proposed,
			summary: a.summary,
			greetingIndex: a.greetingIndex,
			isAdd: a.isAdd,
		});
	}
	// Preserve call order (Map iteration is insertion order, which matches the
	// store's append-then-merge-in-place → stable chronological order).
	return [...byId.values()];
}

/**
 * Aggregate a turn's activities into a proposal. `currentDraft` is the document
 * the editor currently shows (the diff canonical and the greeting base).
 *
 * Profile: the LAST `edit_profile` wins (the model may revise mid-turn; later
 * revisions are more coherent). Its `proposed` becomes `applyRequest.profileMd`
 * verbatim (the backend already canonicalized it) and is parsed for the prose
 * fields of `proposedDraft`.
 *
 * Greetings: applied in call order on top of the current greeting array
 * (`[firstMessage, ...alternateGreetings]`). `edit_greeting` replaces slot
 * `greetingIndex` (0 = primary); `add_alt_greeting` appends. After all tools,
 * slot 0 → `firstMessage`, rest → `alternateGreetings`. If ANY greeting tool
 * fired, both `firstMessage` and `alternateGreetings` are included in the
 * request (the backend takes a full replacement array).
 */
export function aggregateCoauthorProposal(
	activities: CoauthorToolActivity[],
	currentDraft: BuildCharacterDraft,
): CoauthorProposal {
	const finalized = finalizedActivities(activities);
	const summaries = finalized.map((a) => a.summary).filter((s): s is string => typeof s === "string" && s.length > 0);

	if (finalized.length === 0) {
		return { hasProposal: false, proposedDraft: currentDraft, applyRequest: {}, summaries: [] };
	}

	// Start the proposed draft from the current one; override only what's proposed.
	let proposedDraft: BuildCharacterDraft = { ...currentDraft };
	const applyRequest: CoauthorApplyRequest = {};

	// ── Profile (last edit_profile wins) ──────────────────────────────────────
	let lastProfile: ProposedActivity | undefined;
	for (const a of finalized) {
		if (a.target === "profile") lastProfile = a;
	}
	if (lastProfile) {
		applyRequest.profileMd = lastProfile.proposed;
		// Parse the proposed profile.md for the prose fields the editor body shows.
		// parseProfileMd is total (never throws); the backend already canonicalized
		// the proposed text, so this round-trip is stable.
		const parsed = parseProfileMd(lastProfile.proposed);
		proposedDraft = {
			...proposedDraft,
			description: parsed.profile.description,
			scenario: parsed.profile.scenario ?? "",
			mesExample: parsed.profile.mesExample ?? "",
		};
	}

	// ── Greetings (applied in call order) ─────────────────────────────────────
	const greetingTools = finalized.filter((a) => a.target === "greeting");
	if (greetingTools.length > 0) {
		const greetings: string[] = [
			currentDraft.firstMessage ?? "",
			...(currentDraft.alternateGreetings ?? []),
		];
		for (const a of greetingTools) {
			if (a.isAdd) {
				greetings.push(a.proposed);
			} else if (typeof a.greetingIndex === "number") {
				const idx = a.greetingIndex;
				if (idx >= 0 && idx < greetings.length) {
					greetings[idx] = a.proposed;
				} else if (idx >= greetings.length) {
					// Defensive: an out-of-range edit index (shouldn't happen — the tool
					// gates on existing slots) appends rather than silently dropping.
					greetings.push(a.proposed);
				}
			}
		}
		proposedDraft = {
			...proposedDraft,
			firstMessage: greetings[0] ?? "",
			alternateGreetings: greetings.slice(1),
		};
		applyRequest.firstMessage = proposedDraft.firstMessage;
		applyRequest.alternateGreetings = proposedDraft.alternateGreetings;
	}

	return { hasProposal: true, proposedDraft, applyRequest, summaries };
}

/**
 * CA-12 — Rebuild the Apply request for a HUNK-LEVEL (partial) selection.
 *
 * The user toggles individual hunks in the reviewing diff (see
 * `coauthor-hunk-merge.ts`); `mergedBody` is the hybrid body reflecting their
 * selection (selected hunks take the proposed lines, rejected hunks keep the
 * original). This turns that merged body back into a {@link CoauthorApplyRequest}
 * the CA-7 backend accepts.
 *
 * Semantics, consistent with CA-11's body-space decision:
 *  - **Profile prose** (PERSONALITY/SCENARIO/EXAMPLES): if the turn proposed a
 *    profile edit, the request's `profileMd` is REBUILT — the model's proposed
 *    FRONTMATTER (name rename, tags, creatorNotes, vt config, unknown keys) is
 *    preserved verbatim, but the three prose H1 bodies are overridden with the
 *    merged values from the selected hunks. Frontmatter is not in the body diff
 *    (it can't be faithfully rebuilt on the frontend — `creator`/
 *    `character_version` live in `extensions`), so a rename applies wholesale
 *    regardless of hunk selection; only the prose bodies are granular. The
 *    backend's Apply parses this rebuilt profile.md and overwrites the prose +
 *    meta fields (unchanged sections are identical to current → no-op).
 *  - **Greetings**: if the turn proposed greeting edits, `firstMessage` +
 *    `alternateGreetings` come from the merged body's `# GREETINGS` section
 *    (selected greeting hunks applied, rejected ones reverted). If no greeting
 *    tool fired, greetings are omitted (the backend leaves them untouched).
 *
 * `base` is the wholesale proposal from {@link aggregateCoauthorProposal}; it
 * tells us WHICH fields were proposed (so we don't send fields the model never
 * touched) and carries the proposed frontmatter for the profile rebuild.
 *
 * Pure: no I/O, no React, no store reads.
 */
export function buildPartialApplyRequest(
	mergedBody: string,
	base: CoauthorProposal,
): CoauthorApplyRequest {
	const req: CoauthorApplyRequest = {};

	// ── Profile: rebuild the proposed profile.md with merged prose bodies. ──────
	if (base.applyRequest.profileMd !== undefined) {
		const parsed = parseProfileMd(base.applyRequest.profileMd);
		const mergedProse = pinBodyFields(mergedBody);
		req.profileMd = serializeProfileMd({
			profile: {
				...parsed.profile,
				description: mergedProse.description,
				// The editor body codec uses empty-string for an absent optional section;
				// the profile-md codec uses null. Translate so re-serialization omits
				// empty sections (matching canonical emission), not `# SCENARIO` + "".
				scenario: mergedProse.scenario.trim() ? mergedProse.scenario : null,
				mesExample: mergedProse.mesExample.trim() ? mergedProse.mesExample : null,
			},
			unknownFrontmatter: parsed.unknownFrontmatter,
			unknownVt: parsed.unknownVt,
			unknownSections: parsed.unknownSections,
		});
	}

	// ── Greetings: merged greetings, only if the turn proposed any. ────────────
	if (base.applyRequest.firstMessage !== undefined) {
		const mergedGreetings = pinGreetingsFields(mergedBody);
		req.firstMessage = mergedGreetings.firstMessage;
		req.alternateGreetings = mergedGreetings.alternateGreetings;
	}

	return req;
}
