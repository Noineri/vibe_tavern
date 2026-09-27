/**
 * Fly Tribunal — FT-18R nose discrimination matrix (combined run, step 4).
 *
 * Runs every candidate nose over the synthetic declared-defect corpus
 * (scripts/generate-fly-synthetic-corpus.ts output) and answers the program's
 * first question: can ANY nose carry the declared defects through the fixed
 * connectome pipeline at all?
 *
 * Method — mirrors the raw historical harness exactly, per profile:
 * - one fresh engine per (nose, profile, projection-mode candidate);
 * - the profile's oldest 70% of batches trains, the next 15% validates and
 *   freezes the projection mode (the only tuned choice), the newest 15% is
 *   scored once prequentially;
 * - one continuous replay clock per profile run (flat-delta decay);
 * - PLUS corpus-specific diagnostics the raw harness cannot compute:
 *   pairwise accuracy PER DEFECT CLASS, flag rates on near-miss keeps (the
 *   false-alert control), and accuracy split by holdout vs seen bases.
 *
 * Usage:
 *   bun scripts/calibrate-fly-nose-matrix.ts --corpus <corpus.json>
 *     [--noses old,wide,style,char,multi] [--vectors <file> (embedder)]
 *     [--connectome services/api/assets/fly/connectome.bin.gz]
 *     [--lifetime inf] [--out <result.json>] [--seed 42] [--resamples 10000]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
	createFlyEngine,
	parseConnectome,
	type FlyConnectome,
	type FlyProjectionMode,
} from "../apps/web/src/lib/fly/fly-engine-core.js";
import {
	advanceReplayClock,
	classAuc,
	createReplayClock,
	FLY_CAL_DAY_MS,
	netDecayFactor,
	pairwiseAccuracy,
	parseLifetimeDays,
	splitChronological,
	summarizeRun,
	trainBatch,
	type FlyCalibrationLifetimeDays,
	type FlyScoredPair,
	type FlyScoredVariant,
	type FlySplitRun,
} from "./calibrate-fly-tribunal.js";
import { FLY_NOSE_IDS, resolveFlyNose, type FlyNoseId } from "./fly-nose-registry.js";
import type { FlySyntheticBatch } from "./generate-fly-synthetic-corpus.js";

// ─── Defect-aware prequential runner ────────────────────────────────────────

/** Structural engine slice the runner needs (real FlyEngine satisfies it). */
export interface FlyMatrixEngine {
	/** FT-18R diagnostic seam: unclamped margin — the discriminating readout
	 * that survives saturation (see fly-engine-core.ts FlyDiagnosticEvaluation). */
	evaluateDiagnostic(text: string): { confidence: number; rawMargin: number; unitChange: number; activeKcIndexes: number[] };
	applyThreeFactor(activeKcIndexes: readonly number[], danCluster: "PPL1" | "PAM", strength: number): void;
	applyExponentialDecay(elapsedMs: number, lifetimeDays: number | null): number;
}

/** A pairwise decision annotated with the corpus metadata the matrix reports on. */
export interface FlyMatrixPair extends FlyScoredPair {
	profileId: string;
	/** Defect of the REJECTED variant (null = a clean text lost its batch). */
	rejectedDefect: string | null;
	/** True when the rejected variant was a mild near-miss control. */
	rejectedNearMiss: boolean;
	/** True when the batch was built on a holdout (unseen) base. */
	holdout: boolean;
	/** Unclamped learned margins — the saturation-proof comparison. */
	rejectedMargin: number;
	keptMargin: number;
}

/** A scored variant plus its unclamped margin. */
export interface FlyMatrixScored extends FlyScoredVariant {
	margin: number;
}

export interface FlyMatrixRun extends FlySplitRun {
	scored: FlyMatrixScored[];
	pairs: FlyMatrixPair[];
	/** Margins of KEPT near-miss variants — the false-alert control set. */
	nearMissKeptMargins: number[];
	/** Clamped confidences of KEPT near-miss variants (saturation reference). */
	nearMissKeptConfidences: number[];
}

function isNearMissKind(defect: string | null): boolean {
	return defect !== null && defect.endsWith("-mild");
}

/**
 * Defect-aware mirror of the harness `runPrequential`: identical
 * score-before-train semantics and strengths, but pairs carry the rejected
 * variant's defect class, near-miss flag, and holdout flag, and kept
 * near-miss confidences are collected for the false-alert table.
 */
export function runDefectAwarePrequential(
	engine: FlyMatrixEngine,
	batches: readonly FlySyntheticBatch[],
	clock: ReturnType<typeof createReplayClock>,
	lifetimeDays: FlyCalibrationLifetimeDays,
): FlyMatrixRun {
	const run: FlyMatrixRun = { scored: [], pairs: [], nearMissKeptMargins: [], nearMissKeptConfidences: [] };
	for (const batch of batches) {
		advanceReplayClock(engine, clock, Date.parse(batch.createdAt), lifetimeDays);
		const codes = new Map<string, number[]>();
		const confidences = new Map<string, number>();
		const margins = new Map<string, number>();
		for (const variant of batch.variants) {
			const evaluation = engine.evaluateDiagnostic(variant.content);
			codes.set(variant.content, evaluation.activeKcIndexes);
			confidences.set(variant.content, evaluation.confidence);
			margins.set(variant.content, evaluation.rawMargin);
		}
		const selected = batch.variants.find((variant) => variant.selected) ?? null;
		if (batch.kind === "implicit") {
			const text = batch.variants[0]!.content;
			const confidence = confidences.get(text) ?? 0;
			const margin = margins.get(text) ?? 0;
			run.scored.push({ batchId: batch.messageId, content: text, rejected: false, confidence, margin, kcCode: codes.get(text) ?? [] });
			if (isNearMissKind(batch.variants[0]!.defect)) {
				run.nearMissKeptConfidences.push(confidence);
				run.nearMissKeptMargins.push(margin);
			}
		} else if (selected !== null) {
			for (const variant of batch.variants) {
				const confidence = confidences.get(variant.content) ?? 0;
				const margin = margins.get(variant.content) ?? 0;
				run.scored.push({
					batchId: batch.messageId,
					content: variant.content,
					rejected: !variant.selected,
					confidence,
					margin,
					kcCode: codes.get(variant.content) ?? [],
				});
				if (variant.selected && isNearMissKind(variant.defect)) {
					run.nearMissKeptConfidences.push(confidence);
					run.nearMissKeptMargins.push(margin);
				}
				if (!variant.selected) {
					run.pairs.push({
					batchId: batch.messageId,
					profileId: batch.profileId,
					rejectedConfidence: confidence,
					keptConfidence: confidences.get(selected.content) ?? 0,
					rejectedMargin: margin,
					keptMargin: margins.get(selected.content) ?? 0,
					rejectedDefect: variant.defect,
					rejectedNearMiss: isNearMissKind(variant.defect),
					holdout: batch.holdout,
				});
				}
			}
		}
		trainBatch(engine, batch, codes);
	}
	return run;
}

// ─── Corpus-specific diagnostics ────────────────────────────────────────────

export interface FlyDefectClassMetrics {
	pairs: number;
	accuracy: number;
}

/** Pairwise accuracy grouped by the rejected variant's defect class. */
export function pairwiseAccuracyByDefect(
	pairs: readonly FlyMatrixPair[],
	accuracyFn: (pairs: readonly FlyMatrixPair[]) => number = pairwiseAccuracy,
): Record<string, FlyDefectClassMetrics> {
	const byDefect = new Map<string, FlyMatrixPair[]>();
	for (const pair of pairs) {
		const key = pair.rejectedDefect ?? "clean";
		const bucket = byDefect.get(key);
		if (bucket === undefined) byDefect.set(key, [pair]);
		else bucket.push(pair);
	}
	const result: Record<string, FlyDefectClassMetrics> = {};
	for (const [defect, bucket] of byDefect) {
		result[defect] = { pairs: bucket.length, accuracy: accuracyFn(bucket) };
	}
	return result;
}

/** Pairwise accuracy on the UNCLAMPED margins — the saturation-proof headline. */
export function pairwiseMarginAccuracy(pairs: readonly FlyMatrixPair[]): number {
	if (pairs.length === 0) return 0;
	let credit = 0;
	for (const pair of pairs) {
		if (pair.rejectedMargin > pair.keptMargin) credit += 1;
		else if (pair.rejectedMargin === pair.keptMargin) credit += 0.5;
	}
	return credit / pairs.length;
}

/** Mann-Whitney AUC on margins: P(rejected variant margin > kept variant margin), ties 0.5. */
export function marginAuc(scored: readonly FlyMatrixScored[]): number {
	const rejected = scored.filter((entry) => entry.rejected).map((entry) => entry.margin);
	const kept = scored.filter((entry) => !entry.rejected).map((entry) => entry.margin);
	if (rejected.length === 0 || kept.length === 0) return 0.5;
	let credit = 0;
	for (const rejection of rejected) {
		for (const keep of kept) {
			credit += rejection > keep ? 1 : rejection === keep ? 0.5 : 0;
		}
	}
	return credit / (rejected.length * kept.length);
}

/** Seeded cluster bootstrap CI for an accuracy-style statistic over batch clusters. */
export function bootstrapPairAccuracy(
	pairs: readonly FlyMatrixPair[],
	accuracyFn: (pairs: readonly FlyMatrixPair[]) => number = pairwiseMarginAccuracy,
	options: { resamples: number; seed: number },
): { low: number; high: number } {
	if (pairs.length === 0) return { low: 0, high: 0 };
	const clusters = new Map<string, FlyMatrixPair[]>();
	for (const pair of pairs) {
		const bucket = clusters.get(pair.batchId);
		if (bucket === undefined) clusters.set(pair.batchId, [pair]);
		else bucket.push(pair);
	}
	const keys = [...clusters.keys()];
	let state = options.seed >>> 0;
	const nextRandom = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
	const resampled: number[] = [];
	for (let index = 0; index < options.resamples; index += 1) {
		const draw: FlyMatrixPair[] = [];
		for (let pick = 0; pick < keys.length; pick += 1) draw.push(...clusters.get(keys[Math.floor(nextRandom() * keys.length)]!)!);
		resampled.push(accuracyFn(draw));
	}
	resampled.sort((a, b) => a - b);
	return {
		low: resampled[Math.floor(0.025 * resampled.length)]!,
		high: resampled[Math.ceil(0.975 * resampled.length) - 1]!,
	};
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/** False-alert control on margins: how often a KEPT near-miss reads worse
 * than the median REJECTED full-defect margin in the same run. */
export interface FlyNearMissMarginControl {
	keptNearMissCount: number;
	rejectedFullDefectCount: number;
	medianRejectedFullDefectMargin: number;
	/** Share of kept near-miss margins above that median (lower = better). */
	shareAboveMedianFullDefect: number;
}

export function nearMissMarginControl(
	pairs: readonly FlyMatrixPair[],
	keptNearMissMargins: readonly number[],
): FlyNearMissMarginControl {
	const fullDefectMargins = pairs
		.filter((pair) => !pair.rejectedNearMiss && pair.rejectedDefect !== null)
		.map((pair) => pair.rejectedMargin);
	const reference = median(fullDefectMargins);
	return {
		keptNearMissCount: keptNearMissMargins.length,
		rejectedFullDefectCount: fullDefectMargins.length,
		medianRejectedFullDefectMargin: reference,
		shareAboveMedianFullDefect: keptNearMissMargins.length === 0
			? 0
			: keptNearMissMargins.filter((margin) => margin > reference).length / keptNearMissMargins.length,
	};
}

/** Flag rates on KEPT near-miss variants — the false-alert control. */
export function nearMissKeptFlagRates(confidences: readonly number[], bars: readonly number[] = [0.5, 0.7, 0.85]): Record<string, number> {
	const rates: Record<string, number> = {};
	for (const bar of bars) {
		rates[String(bar)] = confidences.length === 0
			? 0
			: confidences.filter((confidence) => confidence >= bar).length / confidences.length;
	}
	return rates;
}

/** Accuracy split by holdout (unseen base) vs seen-base pairs. */
export function holdoutSplit(
	pairs: readonly FlyMatrixPair[],
	accuracyFn: (pairs: readonly FlyMatrixPair[]) => number = pairwiseAccuracy,
): { seen: FlyDefectClassMetrics; holdout: FlyDefectClassMetrics } {
	const seen = pairs.filter((pair) => !pair.holdout);
	const holdoutPairs = pairs.filter((pair) => pair.holdout);
	return {
		seen: { pairs: seen.length, accuracy: accuracyFn(seen) },
		holdout: { pairs: holdoutPairs.length, accuracy: accuracyFn(holdoutPairs) },
	};
}

// ─── Matrix main ─────────────────────────────────────────────────────────────

interface CliArgs {
	corpus: string;
	noses: string;
	vectors: string | undefined;
	connectome: string;
	lifetime: string;
	out: string | null;
	seed: number;
	resamples: number;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		corpus: "",
		noses: "old,wide,style,char,multi",
		vectors: undefined,
		connectome: "services/api/assets/fly/connectome.bin.gz",
		lifetime: "inf",
		out: null,
		seed: 42,
		resamples: 10_000,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--corpus") args.corpus = argv[++index] ?? args.corpus;
		else if (arg === "--noses") args.noses = argv[++index] ?? args.noses;
		else if (arg === "--vectors") args.vectors = argv[++index] ?? args.vectors;
		else if (arg === "--connectome") args.connectome = argv[++index] ?? args.connectome;
		else if (arg === "--lifetime") args.lifetime = argv[++index] ?? args.lifetime;
		else if (arg === "--out") args.out = argv[++index] ?? null;
		else if (arg === "--seed") args.seed = Number(argv[++index] ?? args.seed);
		else if (arg === "--resamples") args.resamples = Number(argv[++index] ?? args.resamples);
		else throw new Error(`Unknown matrix argument: ${arg}`);
	}
	if (args.corpus === "") throw new Error("--corpus <file> is required.");
	return args;
}

interface CorpusFile {
	meta: {
		seed: number;
		basePoolSize: number;
		holdoutBaseCount: number;
		targetEvents: number;
	};
	batches: FlySyntheticBatch[];
}

export async function main(argv: string[]): Promise<void> {
	const args = parseArgs(argv);
	const lifetimeDays = parseLifetimeDays(args.lifetime);
	const noseIds = args.noses.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
	for (const id of noseIds) {
		if (!(FLY_NOSE_IDS as readonly string[]).includes(id)) {
			throw new Error(`Unknown nose "${id}" — expected one of ${FLY_NOSE_IDS.join(", ")}.`);
		}
	}
	const corpusPath = resolve(args.corpus);
	const corpus = JSON.parse(await Bun.file(corpusPath).text()) as CorpusFile;
	const profileIds = [...new Set(corpus.batches.map((batch) => batch.profileId))].sort();
	const byProfile = new Map<string, FlySyntheticBatch[]>();
	for (const id of profileIds) byProfile.set(id, []);
	for (const batch of corpus.batches) byProfile.get(batch.profileId)!.push(batch);

	const repoRoot = resolve(import.meta.dir, "..");
	const brainPath = resolve(repoRoot, args.connectome);
	const compressed = new Uint8Array(await new Response(Bun.file(brainPath)).arrayBuffer());
	const connectome: FlyConnectome = await parseConnectome(compressed, async (bytes) => new Uint8Array(gunzipSync(bytes)));

	const results: Record<string, unknown> = {};
	const startedAll = performance.now();
	for (const noseId of noseIds as FlyNoseId[]) {
		const { nose } = await resolveFlyNose(noseId, { vectorsFile: args.vectors });
		console.log(`\n=== nose ${noseId} (${nose.channelCount} channels) ===`);
		const profileResults: unknown[] = [];
		const pooledScored: FlyMatrixScored[] = [];
		const pooledPairs: FlyMatrixPair[] = [];
		const pooledNearMissMargins: number[] = [];
		const pooledNearMissConfidences: number[] = [];
		for (const profileId of profileIds) {
			const splits = splitChronological(byProfile.get(profileId)!);
			const modeRuns = (["binary", "log-synapse"] as const).map((mode) => {
				const engine = createFlyEngine(connectome, { params: { projectionMode: mode }, nose });
				const clock = createReplayClock();
				// Train pass (mirrors the raw harness: clock advances, no scoring).
				for (const batch of splits.train) {
					advanceReplayClock(engine, clock, Date.parse(batch.createdAt), lifetimeDays);
					const codes = new Map<string, number[]>();
					for (const variant of batch.variants) {
						codes.set(variant.content, engine.evaluateDiagnostic(variant.content).activeKcIndexes);
					}
					trainBatch(engine, batch, codes);
				}
				const validation = runDefectAwarePrequential(engine, splits.validation, clock, lifetimeDays);
				return { mode, engine, clock, validation };
			});
			// Mode freeze on the MARGIN readout — the one that survives saturation.
			const winner = modeRuns[0]!.validation.pairs.length === 0
				? modeRuns[0]!
				: (modeRuns.reduce((best, run) =>
					pairwiseMarginAccuracy(run.validation.pairs) > pairwiseMarginAccuracy(best.validation.pairs) ? run : best));
			const test = runDefectAwarePrequential(winner.engine, splits.test, winner.clock, lifetimeDays);
			const marginCi = bootstrapPairAccuracy(test.pairs, pairwiseMarginAccuracy, { resamples: args.resamples, seed: args.seed });
			const marginBlock = {
				accuracy: pairwiseMarginAccuracy(test.pairs),
				accuracyCi: marginCi,
				auc: marginAuc(test.scored),
				perDefectAccuracy: pairwiseAccuracyByDefect(test.pairs, pairwiseMarginAccuracy),
				holdoutSplit: holdoutSplit(test.pairs, pairwiseMarginAccuracy),
				nearMissControl: nearMissMarginControl(test.pairs, test.nearMissKeptMargins),
				validationAccuracy: {
					binary: pairwiseMarginAccuracy(modeRuns[0]!.validation.pairs),
					"log-synapse": pairwiseMarginAccuracy(modeRuns[1]!.validation.pairs),
				},
			};
			const clampedMetrics = summarizeRun(test, { resamples: args.resamples, seed: args.seed });
			const extras = {
				winnerMode: winner.mode,
				clamped: {
					...clampedMetrics,
					perDefectAccuracy: pairwiseAccuracyByDefect(test.pairs),
					nearMissKeptFlagRates: nearMissKeptFlagRates(test.nearMissKeptConfidences),
				},
				replayClock: {
					decayEvents: winner.clock.decayEvents,
					decayedDays: winner.clock.decayedMs / FLY_CAL_DAY_MS,
					netFactor: netDecayFactor(winner.clock, lifetimeDays),
				},
			};
			profileResults.push({
				profileId,
				train: splits.train.length,
				validation: splits.validation.length,
				test: splits.test.length,
				margin: marginBlock,
				...extras,
			});
			pooledScored.push(...test.scored);
			pooledPairs.push(...test.pairs);
			pooledNearMissMargins.push(...test.nearMissKeptMargins);
			pooledNearMissConfidences.push(...test.nearMissKeptConfidences);
			console.log(
				`  [${profileId}] mode ${extras.winnerMode}: margin accuracy ${marginBlock.accuracy.toFixed(4)}` +
				` (CI ${marginCi.low.toFixed(3)}–${marginCi.high.toFixed(3)}), AUC ${marginBlock.auc.toFixed(4)},` +
				` pairs ${test.pairs.length}, holdout acc ${marginBlock.holdoutSplit.holdout.accuracy.toFixed(3)} (${marginBlock.holdoutSplit.holdout.pairs}),` +
				` near-miss>median-defect ${(100 * marginBlock.nearMissControl.shareAboveMedianFullDefect).toFixed(1)}%`,
			);
		}
		const pooledRun: FlySplitRun = { scored: pooledScored, pairs: pooledPairs };
		const pooledClamped = summarizeRun(pooledRun, { resamples: args.resamples, seed: args.seed });
		const pooledMarginCi = bootstrapPairAccuracy(pooledPairs, pairwiseMarginAccuracy, { resamples: args.resamples, seed: args.seed });
		results[noseId] = {
			channels: nose.channelCount,
			pooled: {
				margin: {
					accuracy: pairwiseMarginAccuracy(pooledPairs),
					accuracyCi: pooledMarginCi,
					auc: marginAuc(pooledScored),
					perDefectAccuracy: pairwiseAccuracyByDefect(pooledPairs, pairwiseMarginAccuracy),
					holdoutSplit: holdoutSplit(pooledPairs, pairwiseMarginAccuracy),
					nearMissControl: nearMissMarginControl(pooledPairs, pooledNearMissMargins),
				},
				clamped: { ...pooledClamped, classAucRaw: classAuc(pooledScored) },
			},
			profiles: profileResults,
		};
		console.log(
			`  POOLED: margin accuracy ${pairwiseMarginAccuracy(pooledPairs).toFixed(4)}` +
			` (CI ${pooledMarginCi.low.toFixed(4)}–${pooledMarginCi.high.toFixed(4)}),` +
			` AUC ${marginAuc(pooledScored).toFixed(4)}, clamped accuracy ${pooledClamped.accuracy.toFixed(4)},` +
			` KC-overlap ${pooledClamped.sameBatchKcOverlap?.mean.toFixed(0) ?? "n/a"}`,
		);
	}

	const result = {
		corpus: {
			path: corpusPath,
			meta: corpus.meta,
			profiles: profileIds,
			batches: corpus.batches.length,
		},
		lifetimeDays,
		noses: noseIds,
		results,
		runtimeMs: Math.round(performance.now() - startedAll),
		seed: args.seed,
		resamples: args.resamples,
		caveats: [
			"Synthetic declared-defect corpus: labels come from declared profile rules, not human judgment.",
			"Holdout bases appear only in each profile's test zone (generalization measurement).",
		],
	};
	if (args.out !== null) {
		const outPath = resolve(args.out);
		await mkdir(dirname(outPath), { recursive: true });
		await writeFile(outPath, JSON.stringify(result, null, "\t"));
		console.log(`\nwrote ${outPath}`);
	}
}

if (import.meta.main) {
	await main(process.argv.slice(2));
}
