/**
 * Differential-parity case set — LG-1 (LOREBOOK_GROUP_SCORING_PARITY_REPORT).
 *
 * One declarative case list drives BOTH the ST harness port
 * (`st-world-info-harness.ts`) and the live VT engine
 * (`lore-activation-engine.ts`). Every case feeds the same activated-entry set
 * into both group pipelines, so the only thing under test is the GROUP stage —
 * activation is kept deterministic on the VT side (probability 100, no
 * delay/cooldown/character filters, keys that match the case text, or constant
 * entries), matching the harness's "already-activated" contract.
 *
 * Baseline discipline: `vtExpect` records the CURRENT VT survivors so the diff
 * suite fails loudly when a later LG unit changes behavior — each unit updates
 * the affected expectations to the new (closer-to-ST) outcome and shrinks the
 * `divergences` list. `stExpect` is the parity target and must never change.
 */

import type { ActivationInput } from "../../src/domain/prompt/lore-activation-engine.js";
import { ST_LOGIC, type StScanEntry, type StTimedEffects } from "./st-world-info-harness.js";

// ─── Neutral case shape ──────────────────────────────────────────────────

export interface ParityEntry {
	id: string;
	content?: string;
	keys?: string[];
	secondaryKeys?: string[];
	logic?: "and_any" | "and_all" | "not_any" | "not_all";
	/** ST constant ↔ VT constant. Constants don't need keys to activate. */
	constant?: boolean;
	/** Comma-separated group membership (same string semantics on both sides). */
	group?: string;
	groupWeight?: number;
	/** ST groupOverride ↔ VT prioritizeInclusion. */
	override?: boolean;
	/** ST entry.useGroupScoring (nullable) ↔ VT boolean (null → false pre-LG-2). */
	useGroupScoring?: boolean | null;
	/** "Currently sticky-active": ST → timed-effects buffer; VT → activation
	 *  state within stickyWindow. The entry itself gets stickyWindow = 5. */
	sticky?: boolean;
	/** ST order ↔ VT priority. */
	order?: number;
}

export interface ParityCase {
	id: string;
	/** Chat messages, oldest first. Both sides scan the whole text. */
	text: string[];
	entries: ParityEntry[];
	/** ST global world_info_use_group_scoring. VT has no book default yet
	 *  (pre-LG-2 baseline) — cases relying on it carry D1 in `divergences`. */
	stGlobalUseGroupScoring?: boolean;
	/** Known divergences this case is EXPECTED to show in the baseline. */
	divergences: string[];
	/** Parity target (ST pipeline survivors, sorted). Never changes. */
	stExpect: string[];
	/** Baseline VT survivors (sorted). Updated by LG units as gaps close. */
	vtExpect: string[];
}

// ─── VT adapter ──────────────────────────────────────────────────────────

function toVtInput(c: ParityCase): ActivationInput {
	const stickyIds = new Set(c.entries.filter((e) => e.sticky).map((e) => e.id));
	const activationState: ActivationInput["activationState"] = {};
	for (const id of stickyIds) {
		// Within stickyWindow (5) of currentTurn 1 → the entry stays active
		// through VT's activation-level sticky check.
		activationState[id] = { activatedAtTurn: 1, lastMatchedAtTurn: 1 };
	}
	return {
		lorebooks: [
			{
				id: "lb_parity",
				// ST's global switch ≙ VT's book-level default (threaded through
				// ActivationInput.lorebooks[].useGroupScoring).
				useGroupScoring: c.stGlobalUseGroupScoring ?? false,
				scanDepth: c.text.length, // scan the whole case text
				tokenBudget: 1_000_000,
				tokenBudgetPercent: null,
				recursiveScanning: false,
				maxRecursionSteps: 0,
				includeNames: false,
				minActivations: 0,
				minActivationsDepthMax: 0,
				entries: c.entries.map((e) => ({
					id: e.id,
					title: e.id,
					content: e.content ?? `content of ${e.id}`,
					keys: e.keys ?? [],
					secondaryKeys: e.secondaryKeys ?? [],
					logic: e.logic ?? "and_any",
					position: "before_char",
					depth: 0,
					priority: e.order ?? 10,
					stickyWindow: e.sticky ? 5 : 0,
					cooldownWindow: 0,
					delayWindow: 0,
					constant: e.constant ?? false,
					probability: 100,
					ignoreBudget: true,
					role: "system",
					groupName: e.group ?? "",
					groupWeight: e.groupWeight ?? 100,
					prioritizeInclusion: e.override ?? false,
					// undefined → null (inherit the book default), matching the ST adapter's tri-state.
					useGroupScoring: e.useGroupScoring ?? null,
					excludeRecursion: false,
					preventRecursion: false,
					delayUntilRecursion: false,
					recursionLevel: 0,
					scanDepthOverride: null,
					caseSensitive: false,
					matchWholeWords: false,
					characterFilter: [],
					characterFilterExclude: false,
					matchSources: [],
					enabled: true,
					sortOrder: 0,
				})),
			},
		],
		messages: c.text.map((t, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: t })),
		macroMap: {},
		characterId: "c_parity",
		characterName: "Parity",
		activationState,
		currentTurn: 1,
	};
}

export function vtInputForCase(c: ParityCase): ActivationInput {
	return toVtInput(c);
}

// ─── ST adapter ──────────────────────────────────────────────────────────

const LOGIC_MAP = {
	and_any: ST_LOGIC.AND_ANY,
	and_all: ST_LOGIC.AND_ALL,
	not_any: ST_LOGIC.NOT_ANY,
	not_all: ST_LOGIC.NOT_ALL,
} as const;

export function stEntriesForCase(c: ParityCase): StScanEntry[] {
	return c.entries.map((e) => ({
		id: e.id,
		key: e.keys ?? [],
		keysecondary: e.secondaryKeys ?? [],
		selectiveLogic: LOGIC_MAP[e.logic ?? "and_any"],
		constant: e.constant ?? false,
		group: e.group ?? "",
		groupOverride: e.override ?? false,
		groupWeight: e.groupWeight ?? null, // null → ST DEFAULT_WEIGHT (100)
		useGroupScoring: e.useGroupScoring === undefined ? null : e.useGroupScoring,
		order: e.order ?? 0,
		scanDepth: c.text.length, // same "whole text" scope as the VT book scanDepth
		caseSensitive: false,
		matchWholeWords: false,
	}));
}

export function stTimedForCase(c: ParityCase): StTimedEffects {
	return {
		sticky: new Set(c.entries.filter((e) => e.sticky).map((e) => e.id)),
		cooldown: new Set(),
		delay: new Set(),
	};
}

export function stMessagesForCase(c: ParityCase): string[] {
	return c.text;
}

// ─── Cases ───────────────────────────────────────────────────────────────
//
// Score expectations are computable from the ST formula:
//   score = primaryMatches + secondaryMatches   (and_any)
//         = primaryMatches (+ secondary iff ALL matched)  (and_all)
//         = primaryMatches                       (not_*)
//         = 0                                    (no primary keys at all)
// The weighted-random cases use 0/100 weights so the roll is deterministic
// on both sides without depending on the RNG draw (roll ∈ [0, total) always
// lands on the 100-weight entry).

export const PARITY_CASES: ParityCase[] = [
	{
		// No flags, no global default → both sides fall through to the
		// weighted-random tier. Weights 100/0 make the roll deterministic.
		id: "lottery_weights_deterministic",
		text: ["alpha beta gamma"],
		entries: [
			{ id: "L_heavy", keys: ["alpha"], group: "g", groupWeight: 100 },
			{ id: "L_zero", keys: ["alpha"], group: "g", groupWeight: 0 },
		],
		divergences: [],
		stExpect: ["L_heavy"],
		vtExpect: ["L_heavy"],
	},
	{
		// CLOSED (was D3): secondary keys count under AND_ANY. A: 1 primary + 3
		// secondary (score 4); B: 2 primary (score 2). ST keeps A; LG-3 made VT's
		// groupScore follow the same getScore formula, so both keep A.
		id: "and_any_secondary_flips_winner",
		text: ["storm rain thunder lightning fog calm"],
		entries: [
			{ id: "A_sec", keys: ["storm"], secondaryKeys: ["rain", "thunder", "lightning"], logic: "and_any", group: "g", useGroupScoring: true },
			{ id: "B_pri", keys: ["storm", "rain"], group: "g", useGroupScoring: true },
		],
		divergences: [],
		stExpect: ["A_sec"],
		vtExpect: ["A_sec"],
	},
	{
		// CLOSED (was D3, and_all full match): A: 1 primary + both secondary
		// matched → 3; B: 2 primary → 2. Both keep A after LG-3.
		id: "and_all_full_match_sums",
		text: ["storm rain thunder calm"],
		entries: [
			{ id: "A_full", keys: ["storm"], secondaryKeys: ["rain", "thunder"], logic: "and_all", group: "g", useGroupScoring: true },
			{ id: "B_two", keys: ["storm", "rain"], group: "g", useGroupScoring: true },
		],
		divergences: [],
		stExpect: ["A_full"],
		vtExpect: ["A_full"],
	},
	{
		// Pin (no divergence): and_all with a PARTIAL secondary match scores
		// primary-only on both sides — A: 1, B: 2 → B wins everywhere.
		id: "and_all_partial_match_primary_only",
		text: ["storm rain calm"],
		entries: [
			{ id: "A_part", keys: ["storm"], secondaryKeys: ["rain", "thunder"], logic: "and_all", group: "g", useGroupScoring: true },
			{ id: "B_two", keys: ["storm", "rain"], group: "g", useGroupScoring: true },
		],
		divergences: [],
		stExpect: ["B_two"],
		vtExpect: ["B_two"],
	},
	{
		// CLOSED by LG-4 (pipeline restructure: scoring filter → override → roll).
		// D5 (clean, no D2 involved): a score TIE. A's not_any secondary
		// ("zebra", absent from the text) must not count into the score, so A
		// and B both score 1. ST keeps BOTH max-tied members alive through the
		// scoring filter and they resolve in the weighted roll (weights 0/100 →
		// B). VT's scoring tier terminates the group at the first-at-max entry
		// (activation order) → A wins deterministically.
		// Note: a not_any entry with MATCHED secondary never activates in
		// either system (selective gate), so "secondary counts under NOT_*" is
		// unobservable on activated entries by construction — pinned
		// implicitly by A scoring exactly 1 here.
		id: "not_any_tie_rolls_in_st",
		text: ["storm calm"],
		entries: [
			{ id: "A_not", keys: ["storm"], secondaryKeys: ["zebra"], logic: "not_any", group: "g", useGroupScoring: true, groupWeight: 0 },
			{ id: "B_one", keys: ["calm"], group: "g", useGroupScoring: true, groupWeight: 100 },
		],
		divergences: [],
		stExpect: ["B_one"],
		vtExpect: ["B_one"],
	},
	{
		// CLOSED by LG-4 (pipeline restructure: scoring filter → override → roll).
		// D2+D5: unflagged low scorer survives the ST scoring filter and then
		// WINS the final roll (weights 100/0). VT hard-removes it at the
		// scoring stage (no immunity, scoring terminates the group).
		id: "mixed_flags_unflagged_survives_and_wins_roll",
		text: ["storm rain calm"],
		entries: [
			{ id: "A_flag", keys: ["storm", "rain"], group: "g", useGroupScoring: true, groupWeight: 0 },
			{ id: "B_unflag", keys: ["storm"], group: "g", useGroupScoring: false, groupWeight: 100 },
		],
		divergences: [],
		stExpect: ["B_unflag"],
		vtExpect: ["B_unflag"],
	},
	{
		// CLOSED by LG-4 (pipeline restructure: scoring filter → override → roll).
		// D4: scoring runs BEFORE override in ST — a flagged override entry
		// with a losing score is filtered first, so the other override member
		// wins. VT's priority tier short-circuits before scoring ever runs and
		// picks the first override entry in activation order.
		id: "override_member_losing_score_filtered_first",
		text: ["storm rain calm"],
		entries: [
			{ id: "A_ov_flag", keys: ["storm"], group: "g", override: true, useGroupScoring: true },
			{ id: "B_flag", keys: ["storm", "rain"], group: "g", useGroupScoring: true },
			{ id: "C_ov", keys: ["calm"], group: "g", override: true, useGroupScoring: false },
		],
		divergences: [],
		stExpect: ["C_ov"],
		vtExpect: ["C_ov"],
	},
	{
		// CLOSED by LG-4 (pipeline restructure: scoring filter → override → roll).
		// D6: two override members — ST resolves by max order, VT by
		// first-in-activation-order.
		id: "override_tie_break_max_order",
		text: ["storm calm"],
		entries: [
			{ id: "X_ov_low", keys: ["storm"], group: "g", override: true, order: 5 },
			{ id: "Y_ov_high", keys: ["calm"], group: "g", override: true, order: 10 },
		],
		divergences: [],
		stExpect: ["Y_ov_high"],
		vtExpect: ["Y_ov_high"],
	},
	{
		// CLOSED (was D3, constants): a constant with matching keys scores by
		// its keys in ST (2) and beats the keyed entry (1). LG-3 made VT score
		// constants at their real key matches too, so both keep the constant.
		id: "constant_with_matching_keys_competes",
		text: ["storm rain calm"],
		entries: [
			{ id: "K_const", keys: ["storm", "rain"], constant: true, group: "g", useGroupScoring: true },
			{ id: "K_one", keys: ["calm"], group: "g", useGroupScoring: true },
		],
		divergences: [],
		stExpect: ["K_const"],
		vtExpect: ["K_const"],
	},
	{
		// Pin (no divergence): zero-primary constant scores 0 on both sides
		// (ST getScore returns 0 without primary keys; VT matchCount 0) and
		// loses to a 1-score flagged entry.
		id: "zero_primary_scores_zero",
		text: ["storm calm"],
		entries: [
			{ id: "Z_noprim", keys: [], constant: true, group: "g", useGroupScoring: true },
			{ id: "Z_one", keys: ["storm"], group: "g", useGroupScoring: true },
		],
		divergences: [],
		stExpect: ["Z_one"],
		vtExpect: ["Z_one"],
	},
	{
		// CLOSED by LG-4 (pipeline restructure: scoring filter → override → roll).
		// D1: book-level default. ST global on → every entry competes (the
		// low scorer is removed). VT has no default; with no per-entry flags
		// the group falls through to the weighted roll (weights 100/0 → the
		// low scorer survives AND wins the roll).
		id: "global_default_on_all_compete",
		text: ["storm rain calm"],
		stGlobalUseGroupScoring: true,
		entries: [
			{ id: "G_hi", keys: ["storm", "rain"], group: "g", useGroupScoring: null, groupWeight: 0 },
			{ id: "G_lo", keys: ["storm"], group: "g", useGroupScoring: null, groupWeight: 100 },
		],
		divergences: [],
		stExpect: ["G_hi"],
		vtExpect: ["G_hi"],
	},
	{
		// D8: a sticky-active member dominates the group in ST (scoring and
		// the roll are skipped). VT's group stage ignores sticky entirely —
		// the sticky constant (score 0) is removed by the scoring filter.
		id: "sticky_dominates_group",
		text: ["storm rain calm"],
		entries: [
			{ id: "S_sticky", keys: [], constant: true, group: "g", useGroupScoring: true, sticky: true },
			{ id: "S_scorer", keys: ["storm", "rain"], group: "g", useGroupScoring: true },
		],
		divergences: ["D8"],
		stExpect: ["S_sticky"],
		vtExpect: ["S_scorer"],
	},
	{
		// Pin (no divergence): multi-group membership — losing in one group
		// removes the entry on both sides (union of removals), even though it
		// would have won its other group.
		id: "multi_group_membership_union",
		text: ["storm rain calm"],
		entries: [
			{ id: "M_both", keys: ["storm"], group: "g1,g2", useGroupScoring: true },
			{ id: "M_g1_strong", keys: ["storm", "rain"], group: "g1", useGroupScoring: true },
			{ id: "M_g2_weak", keys: ["calm"], group: "g2", useGroupScoring: true, groupWeight: 0 },
		],
		divergences: [],
		stExpect: ["M_g1_strong"],
		vtExpect: ["M_g1_strong"],
	},
];
