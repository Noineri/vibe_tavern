import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
	bootstrapAccuracyCi,
	classAuc,
	mulberry32,
	pairwiseAccuracy,
	runPrequential,
	splitChronological,
	summarizeRun,
	worstFailures,
	type FlyCalibrationBatch,
	type FlyScoredPair,
	type FlyScoredVariant,
} from "./calibrate-fly-tribunal.js";
import {
	createFlyEngine,
	parseConnectome,
	type FlyConnectome,
	type FlyEngine,
} from "../apps/web/src/lib/fly/fly-engine-core.js";

/**
 * FT-18 calibration harness logic (FLY_TRIBUNAL_PLAN Wave 8).
 *
 * L1 checklist:
 * 1. Paths: repo root derives from import.meta.dir; fixture scratch uses
 *    join(tmpdir(), ...); no machine literals.
 * 2. Restores: the only external state is the generated fixture directory,
 *    removed in afterAll; no globals, registries, env, or mocks are patched.
 * 3. Determinism: seeded PRNG and the FT-1 seeded fixture; every assertion
 *    reads a completed pure computation; no sleeps.
 * 4. Platform: node:path derives every path; no separator or OS assumptions.
 * 5. Shared worker pool: no module mocks or mutable global registries.
 * 6. Stable state: assertions inspect returned arrays and engine state only.
 */

const repoRoot = resolve(import.meta.dir, "..");
const buildScript = join(repoRoot, "scripts", "build-fly-connectome.ts");
let fixtureDir = "";
let connectome: FlyConnectome;

async function decompressFixture(compressed: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(gunzipSync(compressed));
}

function freshEngine(): FlyEngine {
	return createFlyEngine(connectome);
}

function choiceBatch(id: string, createdAt: string, rejected: string, kept: string): FlyCalibrationBatch {
	return {
		messageId: id,
		chatId: `chat_${id}`,
		position: 1,
		createdAt,
		kind: "choice",
		variants: [
			{ index: 0, content: rejected, selected: false },
			{ index: 1, content: kept, selected: true },
		],
		finalContent: null,
		excludedReason: null,
	};
}

function implicitBatch(id: string, createdAt: string, content: string): FlyCalibrationBatch {
	return {
		messageId: id,
		chatId: `chat_${id}`,
		position: 1,
		createdAt,
		kind: "implicit",
		variants: [{ index: 0, content, selected: false }],
		finalContent: null,
		excludedReason: null,
	};
}

beforeAll(async () => {
	fixtureDir = join(tmpdir(), `fly-ft18-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const child = Bun.spawn(["bun", buildScript, "--fixture", fixtureDir], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (exitCode !== 0) throw new Error(`FT-1 fixture build failed (${exitCode}): ${stderr}`);
	const bytes = new Uint8Array(await readFile(join(fixtureDir, "connectome.bin.gz")));
	connectome = await parseConnectome(bytes, decompressFixture);
});

afterAll(async () => {
	if (fixtureDir !== "") await rm(fixtureDir, { recursive: true, force: true });
});

describe("FT-18 chronological split", () => {
	test("cuts 70/15/15 on complete batch boundaries in chronological order", () => {
		const batches = Array.from({ length: 100 }, (_, index) =>
			implicitBatch(`m${String(index).padStart(3, "0")}`, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), `text ${index}`),
		);
		const shuffled = [...batches].reverse();
		const splits = splitChronological(shuffled);

		expect(splits.train).toHaveLength(70);
		expect(splits.validation).toHaveLength(15);
		expect(splits.test).toHaveLength(15);
		expect(splits.train[0]!.messageId).toBe("m000");
		expect(splits.train.at(-1)!.messageId).toBe("m069");
		expect(splits.validation[0]!.messageId).toBe("m070");
		expect(splits.test.at(-1)!.messageId).toBe("m099");
	});
});

describe("FT-18 pairwise metrics", () => {
	const pair = (batchId: string, rejectedConfidence: number, keptConfidence: number): FlyScoredPair => ({
		batchId,
		rejectedConfidence,
		keptConfidence,
	});

	test("accuracy counts wins, ties earn half credit", () => {
		const pairs = [pair("a", 0.8, 0.2), pair("b", 0.3, 0.3), pair("c", 0.1, 0.9)];
		expect(pairwiseAccuracy(pairs)).toBeCloseTo((1 + 0.5 + 0) / 3, 10);
		expect(pairwiseAccuracy([])).toBe(0);
	});

	test("class AUC separates perfectly, inverts, and handles ties", () => {
		const scored = (values: Array<[number, boolean]>): FlyScoredVariant[] =>
			values.map(([confidence, rejected], index) => ({
				batchId: `b${index}`,
				content: `t${index}`,
				rejected,
				confidence,
				kcCode: [],
			}));
		expect(classAuc(scored([[0.9, true], [0.8, true], [0.2, false], [0.1, false]]))).toBe(1);
		expect(classAuc(scored([[0.1, true], [0.2, true], [0.8, false], [0.9, false]]))).toBe(0);
		expect(classAuc(scored([[0.5, true], [0.5, false]]))).toBe(0.5);
		expect(classAuc(scored([[0.5, true]]))).toBe(0.5);
	});

	test("cluster bootstrap is deterministic and brackets the point estimate", () => {
		const pairs: FlyScoredPair[] = [];
		for (let batch = 0; batch < 20; batch += 1) {
			for (let repeat = 0; repeat < 3; repeat += 1) {
				pairs.push(pair(`b${batch}`, batch % 2 === 0 ? 0.9 : 0.2, 0.4));
			}
		}
		const first = bootstrapAccuracyCi(pairs, { resamples: 2000, seed: 42 });
		const second = bootstrapAccuracyCi(pairs, { resamples: 2000, seed: 42 });
		expect(first).toEqual(second);
		const estimate = pairwiseAccuracy(pairs);
		expect(first.low).toBeLessThanOrEqual(estimate + 1e-12);
		expect(first.high).toBeGreaterThanOrEqual(estimate - 1e-12);
		expect(first.low).toBeLessThan(first.high);
	});

	test("mulberry32 reproduces its stream for a fixed seed", () => {
		const a = mulberry32(7);
		const b = mulberry32(7);
		const streamA = [a(), a(), a()];
		const streamB = [b(), b(), b()];
		expect(streamA).toEqual(streamB);
		expect(streamA.every((value) => value >= 0 && value < 1)).toBe(true);
	});
});

describe("FT-18 prequential scoring", () => {
	test("variants are scored against pre-batch weights, then the batch trains", () => {
		const rejectedText = "violet lantern harbor";
		const keptText = "marble compass beneath rain";
		const first = runPrequential(freshEngine(), [choiceBatch("m1", "2026-01-01T00:00:00.000Z", rejectedText, keptText)]);
		// Fresh engine: both sides of the pair are exactly 0 (tie, half credit).
		expect(first.pairs).toHaveLength(1);
		expect(first.pairs[0]!.rejectedConfidence).toBe(0);
		expect(first.pairs[0]!.keptConfidence).toBe(0);

		const trained = freshEngine();
		runPrequential(trained, [choiceBatch("m1", "2026-01-01T00:00:00.000Z", rejectedText, keptText)]);
		const second = runPrequential(trained, [choiceBatch("m2", "2026-01-02T00:00:00.000Z", rejectedText, keptText)]);
		// After m1 trained PPL1 on the rejected text, the SAME rejected text
		// scores above the untouched kept text in m2 — score-before-update.
		expect(second.pairs[0]!.rejectedConfidence).toBeGreaterThan(0);
		expect(second.pairs[0]!.rejectedConfidence).toBeGreaterThan(second.pairs[0]!.keptConfidence);
		// And m1's own scores were not retroactively changed by its training.
		expect(first.pairs[0]!.rejectedConfidence).toBe(0);
	});

	test("implicit batches contribute one kept record and excluded batches nothing", () => {
		const excluded = { ...choiceBatch("mx", "2026-01-01T00:00:00.000Z", "a", "b"), excludedReason: "no selection" };
		const run = runPrequential(freshEngine(), [
			excluded,
			implicitBatch("mi", "2026-01-02T00:00:00.000Z", "quiet harbor morning"),
		]);
		expect(run.scored).toHaveLength(1);
		expect(run.scored[0]!.rejected).toBe(false);
		expect(run.pairs).toHaveLength(0);
	});

	test("summarizeRun and worstFailures stay coherent on a tiny synthetic run", () => {
		const engine = freshEngine();
		const batches = [
			choiceBatch("m1", "2026-01-01T00:00:00.000Z", "violet lantern harbor", "marble compass beneath rain"),
			choiceBatch("m2", "2026-01-02T00:00:00.000Z", "violet lantern harbor", "thunder orchard glass"),
			implicitBatch("m3", "2026-01-03T00:00:00.000Z", "paper comet river"),
		];
		const run = runPrequential(engine, batches);
		const metrics = summarizeRun(run, { resamples: 500, seed: 1 });
		expect(metrics.pairs).toBe(2);
		expect(metrics.accuracy).toBeGreaterThanOrEqual(0);
		expect(metrics.accuracy).toBeLessThanOrEqual(1);
		expect(metrics.classAuc).toBeGreaterThanOrEqual(0);
		expect(metrics.classAuc).toBeLessThanOrEqual(1);
		expect(Object.keys(metrics.keptFlagRates)).toHaveLength(6);
		expect(metrics.calibrationBins.reduce((total, bin) => total + bin.variants, 0)).toBe(
			run.scored.filter((variant) => batches.find((batch) => batch.messageId === variant.batchId)?.kind === "choice").length,
		);
		const failures = worstFailures(run, 2);
		expect(failures.length).toBeLessThanOrEqual(2);
		for (const failure of failures) {
			expect(failure.keptSnippet.length).toBeLessThanOrEqual(90);
		}
	});
});
