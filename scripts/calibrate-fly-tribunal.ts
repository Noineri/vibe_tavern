/**
 * Fly Tribunal — FT-18 historical holdout calibration harness.
 *
 * Reproducible, read-only measurement of the tribunal's detection quality on
 * the owner's real swipe history (FLY_TRIBUNAL_PLAN Wave 8):
 *
 *   1. the live SQLite DB is opened read-only and copied once via
 *      `VACUUM INTO` into a temp file — the live DB is never written;
 *   2. swipe batches are reconstructed chronologically: a multi-variant
 *      assistant message is one explicit choice (non-selected variants were
 *      rejected, one was kept; final content ≠ selected variant content
 *      means the kept answer was edited before saving), and a single-variant
 *      assistant message followed by a user turn is one implicit keep;
 *   3. the oldest 70% of batches trains BOTH projection modes, the next 15%
 *      validates and freezes the mode (the only tuned choice), and the
 *      newest 15% is scored exactly once prequentially — every variant is
 *      scored BEFORE its own batch trains.
 *
 * Learning strengths mirror the live wiring (rejected PPL1 0.5, implicit keep
 * PAM 0.25, edited save PAM 0.75). The verdict thresholds reported for the
 * false-positive table mirror `fly-tribunal-policy.ts`.
 *
 * Replay clock (FT-18R): batches are replayed at their real `createdAt`
 * times on ONE continuous clock threaded across the train, validation and
 * test passes — before each batch is scored and trained, the summed
 * KC→MBON delta field is decayed by exp(−gap/lifetime), exactly the
 * flat-delta approximation the live persistence tick applies (FT-12).
 * `--lifetime inf` (the default) maps to the engine's null lifetime —
 * permanent memory, numerically identical to the committed FT-18 no-decay
 * baseline run.
 *
 * Usage:
 *   bun scripts/calibrate-fly-tribunal.ts
 *     [--db data/vibe-tavern.db]
 *     [--connectome services/api/assets/fly/connectome.bin.gz]
 *     [--lifetime <7|14|30|inf>]
 *     [--nose <old|wide|style|char|multi|embedder>] [--vectors <file>]
 *     [--out <result.json>] [--seed 42] [--resamples 10000]
 */

import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	createFlyEngine,
	instantiateLearningSubgraph,
	parseConnectome,
	type FlyConnectome,
	type FlyEngine,
	type FlyProjectionMode,
} from "../apps/web/src/lib/fly/fly-engine-core.js";
import { resolveFlyNose, type FlyNoseId } from "./fly-nose-registry.js";

// ─── Shared constants ────────────────────────────────────────────────────────

/** Mirror of `FLY_REJECTED_STRENGTH` in the live wiring. */
export const FLY_CAL_REJECTED_STRENGTH = 0.5;
/** Mirror of `FLY_IMPLICIT_KEEP_STRENGTH`. */
export const FLY_CAL_IMPLICIT_KEEP_STRENGTH = 0.25;
/** Mirror of `FLY_EDITED_SAVE_STRENGTH`. */
export const FLY_CAL_EDITED_SAVE_STRENGTH = 0.75;

/** Hint bars from `FLY_SENSITIVITY_CONFIDENCE` + auto bars — FPR table keys. */
export const FLY_CAL_FLAG_BARS = [0.25, 0.5, 0.7, 0.75, 0.85, 0.95] as const;

/** Mirror of the engine's module-private day constant (`FLY_DAY_MS`). */
export const FLY_CAL_DAY_MS = 86_400_000;

/** Replayable lifetime settings; `null` is the settings-schema ∞ (permanent). */
export type FlyCalibrationLifetimeDays = 7 | 14 | 30 | null;

const FLY_CAL_LIFETIME_DAYS: Record<string, 7 | 14 | 30> = { "7": 7, "14": 14, "30": 30 };

/** Parse `--lifetime`: "7" | "14" | "30" | "inf"/"∞" → engine lifetime value. */
export function parseLifetimeDays(raw: string): FlyCalibrationLifetimeDays {
	if (raw === "inf" || raw === "∞") return null;
	const days = FLY_CAL_LIFETIME_DAYS[raw];
	if (days === undefined) throw new Error(`Unknown lifetime "${raw}" — expected 7, 14, 30, or inf.`);
	return days;
}

/** Structural slice of the engine the replay clock needs — keeps the clock
 *  unit-testable without a connectome. */
export interface FlyDecayCapable {
	applyExponentialDecay(elapsedMs: number, lifetimeDays: number | null): number;
}

/** One continuous replay clock, threaded across train/validation/test passes. */
export interface FlyReplayClock {
	/** `createdAt` (ms) of the last replayed batch, or null before the first. */
	lastMs: number | null;
	/** Sum of applied positive gaps; exp(−decayedMs/lifetime) is the net factor. */
	decayedMs: number;
	/** How many batches advanced the clock with a positive gap. */
	decayEvents: number;
}

export function createReplayClock(): FlyReplayClock {
	return { lastMs: null, decayedMs: 0, decayEvents: 0 };
}

/**
 * Advance the clock to the batch's `createdAt`, decaying the engine first —
 * the same flat-delta exp(−gap/lifetime) the live persistence tick applies.
 * Unknown timestamps (NaN) leave the clock untouched; nonpositive gaps are
 * identity (the engine's null lifetime already returns before touching any
 * delta, and multiplying by exp(0) would only burn a pass over the field),
 * and the clock never moves backwards.
 */
export function advanceReplayClock(
	engine: FlyDecayCapable,
	clock: FlyReplayClock,
	batchCreatedAtMs: number,
	lifetimeDays: FlyCalibrationLifetimeDays,
): number {
	if (!Number.isFinite(batchCreatedAtMs)) return 1;
	if (clock.lastMs === null) {
		clock.lastMs = batchCreatedAtMs;
		return 1;
	}
	const gap = batchCreatedAtMs - clock.lastMs;
	if (gap <= 0) return 1;
	clock.decayedMs += gap;
	clock.decayEvents += 1;
	clock.lastMs = batchCreatedAtMs;
	return engine.applyExponentialDecay(gap, lifetimeDays);
}

/** exp(−decayedMs/lifetime) — the net decay applied across the whole replay. */
export function netDecayFactor(clock: FlyReplayClock, lifetimeDays: FlyCalibrationLifetimeDays): number {
	if (lifetimeDays === null || clock.decayedMs === 0) return 1;
	return Math.exp(-clock.decayedMs / (lifetimeDays * FLY_CAL_DAY_MS));
}

export interface FlyCalibrationVariant {
	index: number;
	content: string;
	selected: boolean;
}

export interface FlyCalibrationBatch {
	messageId: string;
	chatId: string;
	position: number;
	createdAt: string;
	/** `choice` = multi-variant; `implicit` = single variant followed by user. */
	kind: "choice" | "implicit";
	variants: FlyCalibrationVariant[];
	/** Final shown content; differs from the selected variant when she edited. */
	finalContent: string | null;
	/** Set for batches excluded from training and scoring, with the reason. */
	excludedReason: string | null;
}

export interface FlyChronologicalKey {
	createdAt: string;
	chatId: string;
	position: number;
	messageId: string;
}

function compareChronological(a: FlyChronologicalKey, b: FlyChronologicalKey): number {
	const timeA = Date.parse(a.createdAt);
	const timeB = Date.parse(b.createdAt);
	if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeA - timeB;
	const byTime = a.createdAt.localeCompare(b.createdAt);
	if (byTime !== 0) return byTime;
	const byChat = a.chatId.localeCompare(b.chatId);
	if (byChat !== 0) return byChat;
	if (a.position !== b.position) return a.position - b.position;
	return a.messageId.localeCompare(b.messageId);
}

/** Oldest 70% / next 15% / newest 15%, cut on complete batch boundaries. */
export function splitChronological<T extends FlyChronologicalKey>(
	batches: readonly T[],
): { train: T[]; validation: T[]; test: T[] } {
	const ordered = [...batches].sort(compareChronological);
	const trainEnd = Math.floor(ordered.length * 0.7);
	const validationEnd = Math.floor(ordered.length * 0.85);
	return {
		train: ordered.slice(0, trainEnd),
		validation: ordered.slice(trainEnd, validationEnd),
		test: ordered.slice(validationEnd),
	};
}

// ─── Pairwise metrics ────────────────────────────────────────────────────────

export interface FlyScoredPair {
	batchId: string;
	rejectedConfidence: number;
	keptConfidence: number;
	/** FT-18R unclamped margins — the saturation-proof comparison. */
	rejectedMargin: number;
	keptMargin: number;
}

export interface FlyScoredVariant {
	batchId: string;
	content: string;
	/** True when this text was rejected (non-selected in a choice batch). */
	rejected: boolean;
	confidence: number;
	/** FT-18R unclamped margin behind the clamped confidence. */
	margin: number;
	kcCode: readonly number[];
}

/** Fraction of pairs whose rejected side scored higher; ties earn 0.5. */
export function pairwiseAccuracy(pairs: readonly FlyScoredPair[]): number {
	if (pairs.length === 0) return 0;
	let credit = 0;
	for (const pair of pairs) {
		if (pair.rejectedConfidence > pair.keptConfidence) credit += 1;
		else if (pair.rejectedConfidence === pair.keptConfidence) credit += 0.5;
	}
	return credit / pairs.length;
}

/** Mann–Whitney AUC of confidence against the rejected/kept class. */
export function classAuc(variants: readonly FlyScoredVariant[]): number {
	const rejected = variants.filter((variant) => variant.rejected).map((v) => v.confidence);
	const kept = variants.filter((variant) => !variant.rejected).map((v) => v.confidence);
	if (rejected.length === 0 || kept.length === 0) return 0.5;
	let credit = 0;
	for (const rej of rejected) {
		for (const keep of kept) {
			if (rej > keep) credit += 1;
			else if (rej === keep) credit += 0.5;
		}
	}
	return credit / (rejected.length * kept.length);
}

/** Pairwise accuracy on the UNCLAMPED margins — the saturation-proof readout
 * (FT-18R: the clamped confidence ties at 1 for every text after ~3
 * full-strength events, so margin comparison is the only informative one). */
export function pairwiseMarginAccuracy(pairs: readonly FlyScoredPair[]): number {
	if (pairs.length === 0) return 0;
	let credit = 0;
	for (const pair of pairs) {
		if (pair.rejectedMargin > pair.keptMargin) credit += 1;
		else if (pair.rejectedMargin === pair.keptMargin) credit += 0.5;
	}
	return credit / pairs.length;
}

/** Mann-Whitney AUC on the unclamped margins (ties 0.5). */
export function marginAuc(variants: readonly FlyScoredVariant[]): number {
	const rejected = variants.filter((variant) => variant.rejected).map((v) => v.margin);
	const kept = variants.filter((variant) => !variant.rejected).map((v) => v.margin);
	if (rejected.length === 0 || kept.length === 0) return 0.5;
	let credit = 0;
	for (const rej of rejected) {
		for (const keep of kept) {
			if (rej > keep) credit += 1;
			else if (rej === keep) credit += 0.5;
		}
	}
	return credit / (rejected.length * kept.length);
}

/** Deterministic seeded PRNG so every rerun prints identical intervals. */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Cluster bootstrap over batches (pairs inside one batch share a message and
 * correlate): resample batch ids with replacement, recompute accuracy.
 */
export function bootstrapAccuracyCi(
	pairs: readonly FlyScoredPair[],
	options: { resamples?: number; seed?: number; accuracyFn?: (pairs: readonly FlyScoredPair[]) => number } = {},
): { low: number; high: number } {
	const resamples = options.resamples ?? 10_000;
	const accuracyFn = options.accuracyFn ?? pairwiseAccuracy;
	const random = mulberry32(options.seed ?? 42);
	const byBatch = new Map<string, FlyScoredPair[]>();
	for (const pair of pairs) {
		const bucket = byBatch.get(pair.batchId);
		if (bucket === undefined) byBatch.set(pair.batchId, [pair]);
		else bucket.push(pair);
	}
	const clusters = [...byBatch.values()];
	if (clusters.length === 0 || pairs.length === 0) return { low: 0, high: 0 };
	const accuracies: number[] = [];
	for (let index = 0; index < resamples; index += 1) {
		const sample: FlyScoredPair[] = [];
		for (let pick = 0; pick < clusters.length; pick += 1) {
			sample.push(...clusters[Math.floor(random() * clusters.length)]!);
		}
		accuracies.push(accuracyFn(sample));
	}
	accuracies.sort((a, b) => a - b);
	const lowIndex = Math.floor(accuracies.length * 0.025);
	const highIndex = Math.ceil(accuracies.length * 0.975) - 1;
	return { low: accuracies[lowIndex]!, high: accuracies[Math.max(0, highIndex)]! };
}

// ─── Prequential runner ─────────────────────────────────────────────────────

export interface FlySplitRun {
	scored: FlyScoredVariant[];
	pairs: FlyScoredPair[];
}

/** Replay options: when present, every scored batch first advances the given
 *  clock (decaying the engine by the gap since the previous batch). */
export interface FlyReplayOptions {
	clock: FlyReplayClock;
	lifetimeDays: FlyCalibrationLifetimeDays;
}

/** Structural slice `trainBatch` needs — lets the matrix runner and its
 * tests pass any engine-shaped object, not just the real `FlyEngine`. */
export interface FlyTrainCapable {
	applyThreeFactor(activeKcIndexes: readonly number[], danCluster: "PPL1" | "PAM", strength: number): void;
}

export function trainBatch(engine: FlyTrainCapable, batch: FlyCalibrationBatch, codes: Map<string, number[]>): void {
	const rejectedStrength = FLY_CAL_REJECTED_STRENGTH;
	if (batch.kind === "implicit") {
		const text = batch.finalContent ?? batch.variants[0]!.content;
		const strength = batch.finalContent !== null && batch.finalContent !== batch.variants[0]!.content
			? FLY_CAL_EDITED_SAVE_STRENGTH
			: FLY_CAL_IMPLICIT_KEEP_STRENGTH;
		const code = codes.get(text) ?? [];
		if (code.length > 0) engine.applyThreeFactor(code, "PAM", strength);
		return;
	}
	const selected = batch.variants.find((variant) => variant.selected) ?? null;
	const edited = selected !== null
		&& batch.finalContent !== null
		&& batch.finalContent !== selected.content;
	for (const variant of batch.variants) {
		const code = codes.get(variant.content) ?? [];
		if (code.length === 0) continue;
		if (variant === selected) {
			if (!edited) engine.applyThreeFactor(code, "PAM", FLY_CAL_IMPLICIT_KEEP_STRENGTH);
		} else {
			engine.applyThreeFactor(code, "PPL1", rejectedStrength);
		}
	}
	if (edited && batch.finalContent !== null) {
		const code = codes.get(batch.finalContent) ?? [];
		if (code.length > 0) engine.applyThreeFactor(code, "PAM", FLY_CAL_EDITED_SAVE_STRENGTH);
	}
}

/** Score every variant of every batch BEFORE training that batch (strict
 * prequential "score-before-update" semantics), then train the batch. The
 * engine is mutated in place so split passes can continue one another; with
 * `replay` the passes share one continuous decay clock.
 */
export function runPrequential(
	engine: FlyEngine,
	batches: readonly FlyCalibrationBatch[],
	replay?: FlyReplayOptions,
): FlySplitRun {
	const run: FlySplitRun = { scored: [], pairs: [] };
	for (const batch of batches) {
		if (batch.excludedReason !== null) continue;
		if (replay !== undefined) {
			advanceReplayClock(engine, replay.clock, Date.parse(batch.createdAt), replay.lifetimeDays);
		}
		const codes = new Map<string, number[]>();
		const confidences = new Map<string, number>();
		const margins = new Map<string, number>();
		const texts = new Set<string>(batch.variants.map((variant) => variant.content));
		if (batch.finalContent !== null) texts.add(batch.finalContent);
		for (const text of texts) {
			const evaluation = engine.evaluateDiagnostic(text);
			codes.set(text, evaluation.activeKcIndexes);
			confidences.set(text, evaluation.confidence);
			margins.set(text, evaluation.rawMargin);
		}
		const selected = batch.variants.find((variant) => variant.selected) ?? null;
		const edited = selected !== null
			&& batch.finalContent !== null
			&& batch.finalContent !== selected.content;
		if (batch.kind === "choice") {
			for (const variant of batch.variants) {
				run.scored.push({
					batchId: batch.messageId,
					content: variant.content,
					rejected: variant !== selected,
					confidence: confidences.get(variant.content) ?? 0,
					margin: margins.get(variant.content) ?? 0,
					kcCode: codes.get(variant.content) ?? [],
				});
			}
		}
		if (batch.kind === "choice" && selected !== null) {
			const keptText = edited && batch.finalContent !== null ? batch.finalContent : selected.content;
			if (edited && batch.finalContent !== null) {
				run.scored.push({
					batchId: batch.messageId,
					content: batch.finalContent,
					rejected: false,
					confidence: confidences.get(batch.finalContent) ?? 0,
					margin: margins.get(batch.finalContent) ?? 0,
					kcCode: codes.get(batch.finalContent) ?? [],
				});
			}
			const keptConfidence = confidences.get(keptText) ?? 0;
			const keptMargin = margins.get(keptText) ?? 0;
			for (const variant of batch.variants) {
				if (variant === selected) continue;
				run.pairs.push({
					batchId: batch.messageId,
					rejectedConfidence: confidences.get(variant.content) ?? 0,
					keptConfidence,
					rejectedMargin: margins.get(variant.content) ?? 0,
					keptMargin,
				});
			}
		}
		if (batch.kind === "implicit") {
			const text = batch.finalContent ?? batch.variants[0]!.content;
			run.scored.push({
				batchId: batch.messageId,
				content: text,
				rejected: false,
				confidence: confidences.get(text) ?? 0,
				margin: margins.get(text) ?? 0,
				kcCode: codes.get(text) ?? [],
			});
		}
		trainBatch(engine, batch, codes);
	}
	return run;
}

// ─── Corpus reconstruction (read-only) ───────────────────────────────────────

interface MessageRow {
	id: string;
	position: number;
	role: string;
	created_at: string | null;
	content: string | null;
}

interface VariantRow {
	variant_index: number;
	content: string;
	is_selected: number | null;
}

export function buildBatch(
	message: MessageRow,
	variants: VariantRow[],
): FlyCalibrationBatch | null {
	if (variants.length === 0) return null;
	const mapped: FlyCalibrationVariant[] = variants.map((variant) => ({
		index: variant.variant_index,
		content: variant.content,
		selected: variant.is_selected === 1,
	}));
	const multi = mapped.length > 1;
	const finalContent = message.content !== null && message.content.length > 0 ? message.content : null;
	let excludedReason: string | null = null;
	if (multi && !mapped.some((variant) => variant.selected)) {
		excludedReason = "choice batch without a persisted is_selected variant";
	}
	return {
		messageId: message.id,
		chatId: "",
		position: message.position,
		createdAt: message.created_at ?? "",
		kind: multi ? "choice" : "implicit",
		variants: mapped,
		finalContent,
		excludedReason,
	};
}

/** Read-only reconstruction from an already-copied DB file. */
export function reconstructBatches(db: Database): FlyCalibrationBatch[] {
	const chatRows = db
		.query("SELECT chat_id FROM messages WHERE role='assistant' GROUP BY chat_id ORDER BY MIN(created_at), chat_id")
		.all() as Array<{ chat_id: string }>;
	const batches: FlyCalibrationBatch[] = [];
	for (const { chat_id } of chatRows) {
		const messages = db
			.query("SELECT id, position, role, created_at, content FROM messages WHERE chat_id=? ORDER BY position")
			.all(chat_id) as unknown as MessageRow[];
		for (let index = 0; index < messages.length; index += 1) {
			const message = messages[index]!;
			if (message.role !== "assistant") continue;
			const variants = db
				.query("SELECT variant_index, content, is_selected FROM message_variants WHERE message_id=? ORDER BY variant_index")
				.all(message.id) as unknown as VariantRow[];
			if (variants.length === 0) continue;
			const next = messages[index + 1] ?? null;
			const batch = buildBatch(message, variants);
			if (batch === null) continue;
			batch.chatId = chat_id;
			// A single-variant assistant message only counts as an implicit
			// keep when the user actually continued the conversation.
			if (batch.kind === "implicit" && next?.role !== "user") {
				batch.excludedReason = "single variant without a following user turn";
			}
			batches.push(batch);
		}
	}
	return batches;
}

// ─── Calibration report helpers ─────────────────────────────────────────────

export interface FlySplitMetrics {
	batches: number;
	scoredVariants: number;
	pairs: number;
	accuracy: number;
	accuracyCi: { low: number; high: number };
	classAuc: number;
	selectedRankNormalized: number;
	selectedArgmaxShare: number;
	keptFlagRates: Record<string, number>;
	calibrationBins: Array<{ bin: string; variants: number; rejectedShare: number }>;
	sameBatchKcOverlap: { mean: number; meanFractionOfRejected: number } | null;
}

export function summarizeRun(run: FlySplitRun, options: { resamples?: number; seed?: number } = {}): FlySplitMetrics {
	const choiceBatches = new Set(
		run.scored.filter((variant) => variant.rejected).map((variant) => variant.batchId),
	);
	const pairs = run.pairs;
	const accuracy = pairwiseAccuracy(pairs);
	const accuracyCi = bootstrapAccuracyCi(pairs, options);
	const classVariants = run.scored.filter((variant) => choiceBatches.has(variant.batchId));
	// False positives are flagged KEPT texts of any kind: choice keeps,
	// edited saves, and implicit keeps are all things she chose to keep.
	const keptVariants = run.scored.filter((variant) => !variant.rejected);
	const keptFlagRates: Record<string, number> = {};
	for (const bar of FLY_CAL_FLAG_BARS) {
		const flagged = keptVariants.filter((variant) => variant.confidence >= bar).length;
		keptFlagRates[String(bar)] = keptVariants.length === 0 ? 0 : flagged / keptVariants.length;
	}
	const byBatch = new Map<string, FlyScoredVariant[]>();
	for (const variant of run.scored) {
		if (!choiceBatches.has(variant.batchId)) continue;
		const bucket = byBatch.get(variant.batchId);
		if (bucket === undefined) byBatch.set(variant.batchId, [variant]);
		else bucket.push(variant);
	}
	let rankSum = 0;
	let argmaxHits = 0;
	let rankBatches = 0;
	for (const variants of byBatch.values()) {
		const kept = variants.filter((variant) => !variant.rejected);
		const rejected = variants.filter((variant) => variant.rejected);
		if (kept.length === 0 || rejected.length === 0) continue;
		const bestKept = Math.max(...kept.map((variant) => variant.confidence));
		const better = rejected.filter((variant) => variant.confidence > bestKept).length;
		rankSum += better / variants.length;
		rankBatches += 1;
		if (better === 0 && rejected.every((variant) => variant.confidence < bestKept)) argmaxHits += 1;
	}
	const bins = [
		{ bin: "[0.0,0.2)", low: 0, high: 0.2 },
		{ bin: "[0.2,0.4)", low: 0.2, high: 0.4 },
		{ bin: "[0.4,0.6)", low: 0.4, high: 0.6 },
		{ bin: "[0.6,0.8)", low: 0.6, high: 0.8 },
		{ bin: "[0.8,1.0]", low: 0.8, high: 1.01 },
	];
	const calibrationBins = bins.map(({ bin, low, high }) => {
		const inBin = classVariants.filter((variant) => variant.confidence >= low && variant.confidence < high);
		const rejectedShare = inBin.length === 0
			? 0
			: inBin.filter((variant) => variant.rejected).length / inBin.length;
		return { bin, variants: inBin.length, rejectedShare };
	});
	let overlapSum = 0;
	let overlapFractionSum = 0;
	let overlapPairs = 0;
	for (const variants of byBatch.values()) {
		const kept = variants.filter((variant) => !variant.rejected);
		const rejected = variants.filter((variant) => variant.rejected);
		for (const keep of kept) {
			for (const rej of rejected) {
				const keepSet = new Set(keep.kcCode);
				const overlap = rej.kcCode.filter((index) => keepSet.has(index)).length;
				overlapSum += overlap;
				overlapFractionSum += rej.kcCode.length === 0 ? 0 : overlap / rej.kcCode.length;
				overlapPairs += 1;
			}
		}
	}
	return {
		batches: byBatch.size,
		scoredVariants: run.scored.length,
		pairs: pairs.length,
		accuracy,
		accuracyCi,
		classAuc: classAuc(classVariants),
		selectedRankNormalized: rankBatches === 0 ? 0 : rankSum / rankBatches,
		selectedArgmaxShare: rankBatches === 0 ? 0 : argmaxHits / rankBatches,
		keptFlagRates,
		calibrationBins,
		sameBatchKcOverlap: overlapPairs === 0
			? null
			: { mean: overlapSum / overlapPairs, meanFractionOfRejected: overlapFractionSum / overlapPairs },
	};
}

export interface FlyWorstPair {
	margin: number;
	batchId: string;
	keptSnippet: string;
	rejectedSnippet: string;
}

/** Largest failures: kept text scored far ABOVE a rejected alternative. */
export function worstFailures(run: FlySplitRun, count = 5): FlyWorstPair[] {
	const contentByBatch = new Map<string, FlyScoredVariant[]>();
	for (const variant of run.scored) {
		const bucket = contentByBatch.get(variant.batchId);
		if (bucket === undefined) contentByBatch.set(variant.batchId, [variant]);
		else bucket.push(variant);
	}
	return run.pairs
		.map((pair) => ({ pair, variants: contentByBatch.get(pair.batchId) ?? [] }))
		.filter(({ variants }) => {
			const kept = variants.find((variant) => !variant.rejected);
			const rejected = variants.find((variant) => variant.rejected);
			return kept !== undefined && rejected !== undefined;
		})
		.map(({ pair, variants }) => {
			const kept = variants.find((variant) => !variant.rejected)!;
			const rejected = variants.find((variant) => variant.rejected)!;
			return {
				margin: pair.keptConfidence - pair.rejectedConfidence,
				batchId: pair.batchId,
				keptSnippet: kept.content.replace(/\s+/g, " ").slice(0, 90),
				rejectedSnippet: rejected.content.replace(/\s+/g, " ").slice(0, 90),
			};
		})
		.sort((a, b) => b.margin - a.margin)
		.slice(0, count);
}

// ─── Main ────────────────────────────────────────────────────────────────────

interface CliArgs {
	db: string;
	connectome: string;
	lifetime: string;
	nose: string;
	vectors: string | undefined;
	out: string | null;
	seed: number;
	resamples: number;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		db: "data/vibe-tavern.db",
		connectome: "services/api/assets/fly/connectome.bin.gz",
		lifetime: "inf",
		nose: "old",
		vectors: undefined,
		out: null,
		seed: 42,
		resamples: 10_000,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--db") args.db = argv[++index] ?? args.db;
		else if (arg === "--connectome") args.connectome = argv[++index] ?? args.connectome;
		else if (arg === "--lifetime") args.lifetime = argv[++index] ?? args.lifetime;
		else if (arg === "--nose") args.nose = argv[++index] ?? args.nose;
		else if (arg === "--vectors") args.vectors = argv[++index] ?? args.vectors;
		else if (arg === "--out") args.out = argv[++index] ?? null;
		else if (arg === "--seed") args.seed = Number(argv[++index] ?? args.seed);
		else if (arg === "--resamples") args.resamples = Number(argv[++index] ?? args.resamples);
		else throw new Error(`Unknown calibration argument: ${arg}`);
	}
	return args;
}

export async function main(argv: string[]): Promise<void> {
	const args = parseArgs(argv);
	const repoRoot = resolve(import.meta.dir, "..");
	const dbPath = resolve(repoRoot, args.db);
	const brainPath = resolve(repoRoot, args.connectome);
	const workDir = join(tmpdir(), `fly-ft18-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(workDir, { recursive: true });
	const copyPath = join(workDir, "copy.db");
	try {
		const source = new Database(dbPath, { readonly: true });
		source.run(`VACUUM INTO '${copyPath.replaceAll("\\", "/")}'`);
		source.close();
		const db = new Database(copyPath, { readonly: true });
		const batches = reconstructBatches(db);
		const usable = batches.filter((batch) => batch.excludedReason === null);
		const excluded = batches.length - usable.length;
		const choiceCount = usable.filter((batch) => batch.kind === "choice").length;
		const editedCount = usable.filter((batch) => {
			const selected = batch.variants.find((variant) => variant.selected);
			return selected !== undefined && batch.finalContent !== null && batch.finalContent !== selected.content;
		}).length;
		console.log(
			`corpus: ${batches.length} batches (${choiceCount} choice, ${usable.length - choiceCount} implicit),` +
			` ${excluded} excluded, ${editedCount} edited saves`,
		);

		const splits = splitChronological(usable);
		const lifetimeDays = parseLifetimeDays(args.lifetime);
		console.log(`splits: train ${splits.train.length} / validation ${splits.validation.length} / test ${splits.test.length}`);
		console.log(`lifetime: ${lifetimeDays === null ? "∞ (permanent)" : `${lifetimeDays} days`}`);

		const compressed = new Uint8Array(await new Response(Bun.file(brainPath)).arrayBuffer());
		const connectome: FlyConnectome = await parseConnectome(compressed, async (bytes) => new Uint8Array(gunzipSync(bytes)));
		const subgraph = instantiateLearningSubgraph(connectome);
		void subgraph;
		const { nose, id: noseId } = await resolveFlyNose(args.nose, { vectorsFile: args.vectors });
		console.log(`nose: ${noseId} (${nose.channelCount} channels)`);

		const evaluateMode = (
			mode: FlyProjectionMode,
			label: string,
		): { metrics: FlySplitMetrics; marginAccuracy: number; engine: FlyEngine; clock: FlyReplayClock; ms: number } => {
			const engine = createFlyEngine(connectome, { params: { projectionMode: mode }, nose });
			const clock = createReplayClock();
			const started = performance.now();
			let trained = 0;
			for (const batch of splits.train) {
				if (batch.excludedReason !== null) continue;
				advanceReplayClock(engine, clock, Date.parse(batch.createdAt), lifetimeDays);
				const texts = new Set(batch.variants.map((variant) => variant.content));
				if (batch.finalContent !== null) texts.add(batch.finalContent);
				const codes: Array<[string, number[]]> = [];
				for (const text of texts) codes.push([text, engine.evaluateDiagnostic(text).activeKcIndexes]);
				trainBatch(engine, batch, new Map(codes));
				trained += 1;
				if (trained % 500 === 0) console.log(`  [${label}] trained ${trained} train batches`);
			}
			const validationRun = runPrequential(engine, splits.validation, { clock, lifetimeDays });
			const metrics = summarizeRun(validationRun, { resamples: args.resamples, seed: args.seed });
			const marginAccuracy = pairwiseMarginAccuracy(validationRun.pairs);
			const ms = performance.now() - started;
			console.log(
				`[${label}] validation accuracy ${metrics.accuracy.toFixed(4)} (CI ${metrics.accuracyCi.low.toFixed(3)}–${metrics.accuracyCi.high.toFixed(3)}),` +
				` AUC ${metrics.classAuc.toFixed(4)}, pairs ${metrics.pairs}, margin accuracy ${marginAccuracy.toFixed(4)} [${(ms / 1000).toFixed(1)}s]`,
			);
			return { metrics, marginAccuracy, engine, clock, ms };
		};

		const binaryRun = evaluateMode("binary", "binary");
		const logRun = evaluateMode("log-synapse", "log-synapse");
		// FT-18R: freeze on the MARGIN validation accuracy — the clamped readout
		// saturates (ties at ~0.5) and cannot rank modes at this training scale.
		const winner = binaryRun.marginAccuracy >= logRun.marginAccuracy ? binaryRun : logRun;
		const winnerMode: FlyProjectionMode = winner === binaryRun ? "binary" : "log-synapse";
		console.log(`frozen projection mode: ${winnerMode}`);
		console.log(
			`replay clock: ${winner.clock.decayEvents} decay gaps,` +
			` ${(winner.clock.decayedMs / FLY_CAL_DAY_MS).toFixed(1)} days decayed,` +
			` net factor ${netDecayFactor(winner.clock, lifetimeDays).toExponential(3)}`,
		);

		// The winning engine already trained through validation prequentially;
		// the sealed test pass runs exactly once on the newest batches — the
		// winner's clock continues, so decay keeps flowing across the boundary.
		const testStarted = performance.now();
		const testRun = runPrequential(winner.engine, splits.test, { clock: winner.clock, lifetimeDays });
		const testMetrics = summarizeRun(testRun, { resamples: args.resamples, seed: args.seed });
		const testMarginAccuracy = pairwiseMarginAccuracy(testRun.pairs);
		const testMarginCi = bootstrapAccuracyCi(testRun.pairs, { resamples: args.resamples, seed: args.seed, accuracyFn: pairwiseMarginAccuracy });
		const testMarginAuc = marginAuc(testRun.scored);
		console.log(`sealed test: accuracy ${testMetrics.accuracy.toFixed(4)} (CI ${testMetrics.accuracyCi.low.toFixed(4)}–${testMetrics.accuracyCi.high.toFixed(4)}), AUC ${testMetrics.classAuc.toFixed(4)}`);
		console.log(`sealed test (margin): accuracy ${testMarginAccuracy.toFixed(4)} (CI ${testMarginCi.low.toFixed(4)}–${testMarginCi.high.toFixed(4)}), AUC ${testMarginAuc.toFixed(4)}`);

		const deltas = winner.engine.exportSparseDeltas();
		const deltaView = new DataView(deltas.buffer, deltas.byteOffset, deltas.byteLength);
		const weightCount = deltaView.getUint32(4, true);
		const payloadBase64 = Buffer.from(gzipSync(deltas)).toString("base64");

		const result = {
			lifetimeDays,
			nose: noseId,
			caveats: [
				"NON-PRISTINE: the test partition was exposed by the 2026-09-27 FT-18 run — diagnostic only, never an acceptance number.",
			],
			corpus: {
				batches: batches.length,
				usable: usable.length,
				excluded,
				choice: choiceCount,
				implicit: usable.length - choiceCount,
				editedSaves: editedCount,
			},
			splits: {
				train: splits.train.length,
				validation: splits.validation.length,
				test: splits.test.length,
			},
			replayClock: {
				decayEvents: winner.clock.decayEvents,
				decayedMs: winner.clock.decayedMs,
				netDecayFactor: netDecayFactor(winner.clock, lifetimeDays),
			},
			validation: {
				binary: binaryRun.metrics,
				"log-synapse": logRun.metrics,
			},
			validationMarginAccuracy: {
				binary: binaryRun.marginAccuracy,
				"log-synapse": logRun.marginAccuracy,
			},
			winnerMode,
			test: testMetrics,
			testMargin: {
				accuracy: testMarginAccuracy,
				accuracyCi: testMarginCi,
				auc: testMarginAuc,
			},
			weights: {
				nonzeroSynapses: weightCount,
				payloadBase64Length: payloadBase64.length,
			},
			failures: worstFailures(testRun),
			runtimeMs: {
				validationBinary: Math.round(binaryRun.ms),
				validationLog: Math.round(logRun.ms),
				test: Math.round(performance.now() - testStarted),
			},
			seed: args.seed,
			resamples: args.resamples,
		};
		console.log(`weights: ${weightCount} nonzero KC→MBON synapses, gzipped payload ${payloadBase64.length} base64 chars`);
		console.log(`false-positive rates on kept variants: ${JSON.stringify(testMetrics.keptFlagRates)}`);
		console.log(`calibration bins: ${testMetrics.calibrationBins.map((bin) => `${bin.bin}:${bin.variants}@${bin.rejectedShare.toFixed(2)}`).join(" ")}`);
		console.log(`same-batch rejected↔kept KC overlap: ${testMetrics.sameBatchKcOverlap === null ? "n/a" : `${testMetrics.sameBatchKcOverlap.mean.toFixed(0)} mean (${(testMetrics.sameBatchKcOverlap.meanFractionOfRejected * 100).toFixed(1)}% of rejected code)`}`);
		if (testMetrics.accuracyCi.low > 0.5) {
			console.log(`VERDICT: sealed lower bound ${testMetrics.accuracyCi.low.toFixed(4)} exceeds chance 0.5 — the tribunal learns real patterns.`);
		} else {
			console.log(`VERDICT: sealed lower bound ${testMetrics.accuracyCi.low.toFixed(4)} does NOT exceed chance 0.5 — no reliable text signal measured.`);
		}
		for (const failure of result.failures) {
			console.log(`  worst +${failure.margin.toFixed(3)} kept "${failure.keptSnippet}" over rejected "${failure.rejectedSnippet}"`);
		}
		if (args.out !== null) {
			const outPath = resolve(args.out);
			await writeFile(outPath, JSON.stringify(result, null, "\t"));
			console.log(`wrote ${outPath}`);
		}
		db.close();
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	await main(process.argv.slice(2));
}
