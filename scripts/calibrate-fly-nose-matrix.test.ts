import { describe, expect, test } from "bun:test";
import {
	holdoutSplit,
	nearMissKeptFlagRates,
	pairwiseAccuracyByDefect,
	runDefectAwarePrequential,
	type FlyMatrixEngine,
	type FlyMatrixPair,
} from "./calibrate-fly-nose-matrix.js";
import { createReplayClock, type FlyCalibrationLifetimeDays } from "./calibrate-fly-tribunal.js";
import { resolveFlyNose } from "./fly-nose-registry.js";
import type { FlySyntheticBatch } from "./generate-fly-synthetic-corpus.js";

/**
 * FT-18R nose matrix tests. Pure logic — fake engines, no connectome, no
 * files.
 *
 * L1 checklist:
 * 1. Paths: none — everything is in-memory.
 * 2. Restores: no globals, registries, env vars, or mocks are touched.
 * 3. Determinism: every assertion reads a completed pure computation.
 * 4. Platform: no paths, separators, or OS assumptions.
 * 5. Shared worker pool: scripts tests share one process — no module mocks.
 * 6. Stable state: assertions inspect returned structures only.
 */

class FakeEngine implements FlyMatrixEngine {
	readonly trainCalls: Array<{ cluster: "PPL1" | "PAM"; strength: number }> = [];
	readonly decayCalls: number[] = [];
	constructor(private readonly confidenceBy: ReadonlyMap<string, number>) {}
	evaluate(text: string): { confidence: number; activeKcIndexes: number[] } {
		return { confidence: this.confidenceBy.get(text) ?? 0, activeKcIndexes: [7] };
	}
	applyThreeFactor(_indexes: readonly number[], cluster: "PPL1" | "PAM", strength: number): void {
		this.trainCalls.push({ cluster, strength });
	}
	applyExponentialDecay(elapsedMs: number, _lifetime: number | null): number {
		this.decayCalls.push(elapsedMs);
		return 1;
	}
}

function makeBatch(overrides: Partial<FlySyntheticBatch> & { messageId: string; profileId: string }): FlySyntheticBatch {
	return {
		chatId: `synthetic/${overrides.profileId}`,
		position: 0,
		createdAt: "2024-01-01T00:00:00.000Z",
		kind: "choice",
		finalContent: null,
		excludedReason: null,
		phase: "A",
		holdout: false,
		variants: [],
		...overrides,
	} as FlySyntheticBatch;
}

describe("FT-18R nose matrix: defect-aware runner", () => {
	const clean = "The clean accepted reply, long enough to be a real base text for this tiny fixture.";
	const mono = `${clean}\n\n*He turned her words over slowly, weighing each one against the silence.*`;
	const mild = `${clean}\n\n*Not for the first time, he wondered whether this was progress.*`;

	test("pairs carry defect, near-miss, and holdout metadata; training mirrors live strengths", () => {
		const batch = makeBatch({
			messageId: "m1",
			profileId: "terse",
			holdout: true,
			variants: [
				{ index: 0, content: mono, selected: false, defect: "monologue", baseId: "b-000001" },
				{ index: 1, content: clean, selected: true, defect: null, baseId: "b-000001" },
			],
		});
		const engine = new FakeEngine(new Map([[mono, 0.8], [clean, 0.3]]));
		const run = runDefectAwarePrequential(engine, [batch], createReplayClock(), null as FlyCalibrationLifetimeDays);

		expect(run.pairs).toHaveLength(1);
		expect(run.pairs[0]!.rejectedDefect).toBe("monologue");
		expect(run.pairs[0]!.rejectedNearMiss).toBe(false);
		expect(run.pairs[0]!.holdout).toBe(true);
		expect(run.pairs[0]!.profileId).toBe("terse");
		// Score-before-train: the rejected text evaluated higher ⇒ wrong pair.
		expect(run.pairs[0]!.rejectedConfidence).toBe(0.8);
		expect(run.pairs[0]!.keptConfidence).toBe(0.3);
		// Training mirrors the live wiring: rejected PPL1 0.5, choice keep PAM 0.25.
		expect(engine.trainCalls).toEqual([
			{ cluster: "PPL1", strength: 0.5 },
			{ cluster: "PAM", strength: 0.25 },
		]);
	});

	test("kept near-miss variants feed the false-alert control; implicit batches train PAM 0.25", () => {
		const choice = makeBatch({
			messageId: "m1",
			profileId: "terse",
			variants: [
				{ index: 0, content: clean, selected: false, defect: null, baseId: "b-1" },
				{ index: 1, content: mild, selected: true, defect: "monologue-mild", baseId: "b-1" },
			],
		});
		const implicit = makeBatch({
			messageId: "m2",
			profileId: "terse",
			kind: "implicit",
			variants: [{ index: 0, content: mild, selected: true, defect: "monologue-mild", baseId: "b-2" }],
		});
		const engine = new FakeEngine(new Map([[clean, 0.1], [mild, 0.75]]));
		const run = runDefectAwarePrequential(engine, [choice, implicit], createReplayClock(), null);

		expect(run.nearMissKeptConfidences).toEqual([0.75, 0.75]);
		expect(run.pairs[0]!.rejectedDefect).toBeNull(); // a clean text lost its batch
		expect(run.pairs[0]!.rejectedNearMiss).toBe(false);
		// choice: clean rejected PPL1 + mild keep PAM 0.25; implicit: PAM 0.25.
		expect(engine.trainCalls).toEqual([
			{ cluster: "PPL1", strength: 0.5 },
			{ cluster: "PAM", strength: 0.25 },
			{ cluster: "PAM", strength: 0.25 },
		]);
	});
});

describe("FT-18R nose matrix: diagnostics", () => {
	const pair = (over: Partial<FlyMatrixPair>): FlyMatrixPair => ({
		batchId: "m",
		profileId: "terse",
		rejectedConfidence: 0.8,
		keptConfidence: 0.3,
		rejectedDefect: null,
		rejectedNearMiss: false,
		holdout: false,
		...over,
	});

	test("pairwise accuracy groups by rejected defect class (correct = rejected scores higher)", () => {
		const byDefect = pairwiseAccuracyByDefect([
			pair({ rejectedDefect: "monologue", rejectedConfidence: 0.9 }),
			pair({ rejectedDefect: "monologue", rejectedConfidence: 0.2 }),
			pair({ rejectedDefect: "tag-leak", rejectedConfidence: 0.8 }),
			pair({ rejectedDefect: null }),
		]);
		expect(byDefect.monologue).toEqual({ pairs: 2, accuracy: 0.5 });
		expect(byDefect["tag-leak"]).toEqual({ pairs: 1, accuracy: 1 });
		expect(byDefect.clean.accuracy).toBe(1);
	});

	test("near-miss flag rates and holdout split", () => {
		expect(nearMissKeptFlagRates([0.2, 0.6, 0.9])).toEqual({ "0.5": 2 / 3, "0.7": 1 / 3, "0.85": 1 / 3 });
		const split = holdoutSplit([
			pair({ holdout: false, rejectedConfidence: 0.1 }),
			pair({ holdout: true, rejectedConfidence: 0.9 }),
		]);
		expect(split.seen).toEqual({ pairs: 1, accuracy: 0 });
		expect(split.holdout).toEqual({ pairs: 1, accuracy: 1 });
	});
});

describe("FT-18R nose registry", () => {
	test("resolves every local nose with its channel count", async () => {
		expect((await resolveFlyNose("old")).nose.channelCount).toBe(50);
		expect((await resolveFlyNose("wide")).nose.channelCount).toBe(1024);
		expect((await resolveFlyNose("style")).nose.channelCount).toBe(22);
		expect((await resolveFlyNose("char")).nose.channelCount).toBe(256);
		expect((await resolveFlyNose("multi")).nose.channelCount).toBe(256 + 256 + 22);
	});

	test("embedder without a vectors file and unknown ids fail loud", async () => {
		await expect(resolveFlyNose("embedder")).rejects.toThrow(/--vectors/);
		await expect(resolveFlyNose("banana")).rejects.toThrow(/Unknown nose/);
	});
});
