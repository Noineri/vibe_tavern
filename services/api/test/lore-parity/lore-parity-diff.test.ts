import { describe, expect, it } from "bun:test";
import { resolveActivatedEntries } from "../../src/domain/prompt/lore-activation-engine.js";
import { runStGroupPipeline } from "./st-world-info-harness.js";
import { PARITY_CASES, stEntriesForCase, stMessagesForCase, stTimedForCase, vtInputForCase, type ParityCase } from "./parity-cases.js";

/**
 * Differential parity suite — LG-1 baseline (LOREBOOK_GROUP_SCORING_PARITY_REPORT).
 *
 * Every case runs through BOTH the ST harness port (the real group-pipeline
 * semantics extracted from the owner's ST checkout) and the LIVE VT engine,
 * then compares the surviving sets against the recorded baseline:
 *
 *   - `stExpect` is the parity TARGET (ST pipeline survivors). It must not
 *     change when LG-2..LG-6 land; the VT expectations converge onto it.
 *   - `vtExpect` is the CURRENT VT behavior. Later LG units UPDATE it as the
 *     known divergences close; the updated expectation must equal `stExpect`
 *     minus any remaining documented divergence (D9 migration caveat, and
 *     anything explicitly left open).
 *   - `divergences` lists the D-codes the case is expected to show. When a
 *     unit closes a D-code, it removes it here and aligns vtExpect → stExpect.
 *
 * The whole suite is deterministic by construction: the weighted-random cases
 * use 0/100 weights (the roll always lands on the 100-weight entry regardless
 * of the RNG draw), and probability is 100 everywhere so VT's activation gate
 * never calls Math.random.
 */

function vtSurvivors(c: ParityCase): string[] {
	const result = resolveActivatedEntries(vtInputForCase(c));
	return result.activatedEntries.map((e) => e.id).sort();
}

function stSurvivors(c: ParityCase): string[] {
	const result = runStGroupPipeline(
		stEntriesForCase(c),
		stMessagesForCase(c),
		{
			useGroupScoring: c.stGlobalUseGroupScoring ?? false,
			caseSensitive: false,
			matchWholeWords: false,
			depth: c.text.length,
		},
		stTimedForCase(c),
	);
	return result.survivors.sort();
}

describe("lorebook group parity — differential baseline (LG-1)", () => {
	for (const c of PARITY_CASES) {
		it(`case ${c.id}: ST=${c.stExpect.join("|") || "∅"} VT=${c.vtExpect.join("|") || "∅"}${c.divergences.length ? ` [known: ${c.divergences.join(",")}]` : ""}`, () => {
			const st = stSurvivors(c);
			const vt = vtSurvivors(c);

			// The parity target is pinned first: if the ST PORT itself drifts
			// (checkout update, port bug), this fails independently of VT.
			expect(st).toEqual([...c.stExpect].sort());

			// Baseline of the live VT engine. LG units move this toward stExpect.
			expect(vt).toEqual([...c.vtExpect].sort());

			// Cross-check the recorded divergence claim: a case with no known
			// divergences must ALREADY agree on both sides.
			if (c.divergences.length === 0) {
				expect(vt).toEqual(st);
			} else {
				expect(vt).not.toEqual(st);
			}
		});
	}
});
