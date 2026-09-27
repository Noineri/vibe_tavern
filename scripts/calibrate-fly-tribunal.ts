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
 * Usage:
 *   bun scripts/calibrate-fly-tribunal.ts
 *     [--db data/vibe-tavern.db]
 *     [--connectome services/api/assets/fly/connectome.bin.gz]
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

// ─── Shared constants ────────────────────────────────────────────────────────

/** Mirror of `FLY_REJECTED_STRENGTH` in the live wiring. */
export const FLY_CAL_REJECTED_STRENGTH = 0.5;
/** Mirror of `FLY_IMPLICIT_KEEP_STRENGTH`. */
export const FLY_CAL_IMPLICIT_KEEP_STRENGTH = 0.25;
/** Mirror of `FLY_EDITED_SAVE_STRENGTH`. */
export const FLY_CAL_EDITED_SAVE_STRENGTH = 0.75;

/** Hint bars from `FLY_SENSITIVITY_CONFIDENCE` + auto bars — FPR table keys. */
export const FLY_CAL_FLAG_BARS = [0.25, 0.5, 0.7, 0.75, 0.85, 0.95] as const;

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
}

export interface FlyScoredVariant {
	batchId: string;
	content: string;
	/** True when this text was rejected (non-selected in a choice batch). */
	rejected: boolean;
	confidence: number;
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
	options: { resamples?: number; seed?: number } = {},
): { low: number; high: number } {
	const resamples = options.resamples ?? 10_000;
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
		accuracies.push(pairwiseAccuracy(sample));
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

function trainBatch(engine: FlyEngine, batch: FlyCalibrationBatch, codes: Map<string, number[]>): void {
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

/**
 * Score every variant of every batch BEFORE training that batch (strict
 * prequential "score-before-update" semantics), then train the batch. The
 * engine is mutated in place so split passes can continue one another.
 */
export function runPrequential(engine: FlyEngine, batches: readonly FlyCalibrationBatch[]): FlySplitRun {
	const run: FlySplitRun = { scored: [], pairs: [] };
	for (const batch of batches) {
		if (batch.excludedReason !== null) continue;
		const codes = new Map<string, number[]>();
		const confidences = new Map<string, number>();
		const texts = new Set<string>(batch.variants.map((variant) => variant.content));
		if (batch.finalContent !== null) texts.add(batch.finalContent);
		for (const text of texts) {
			const evaluation = engine.evaluate(text);
			codes.set(text, evaluation.activeKcIndexes);
			confidences.set(text, evaluation.confidence);
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
					kcCode: codes.get(batch.finalContent) ?? [],
				});
			}
			const keptConfidence = confidences.get(keptText) ?? 0;
			for (const variant of batch.variants) {
				if (variant === selected) continue;
				run.pairs.push({
					batchId: batch.messageId,
					rejectedConfidence: confidences.get(variant.content) ?? 0,
					keptConfidence,
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
	out: string | null;
	seed: number;
	resamples: number;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		db: "data/vibe-tavern.db",
		connectome: "services/api/assets/fly/connectome.bin.gz",
		out: null,
		seed: 42,
		resamples: 10_000,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--db") args.db = argv[++index] ?? args.db;
		else if (arg === "--connectome") args.connectome = argv[++index] ?? args.connectome;
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
		console.log(`splits: train ${splits.train.length} / validation ${splits.validation.length} / test ${splits.test.length}`);

		const compressed = new Uint8Array(await new Response(Bun.file(brainPath)).arrayBuffer());
		const connectome: FlyConnectome = await parseConnectome(compressed, async (bytes) => new Uint8Array(gunzipSync(bytes)));
		const subgraph = instantiateLearningSubgraph(connectome);

		const evaluateMode = (mode: FlyProjectionMode, label: string): { metrics: FlySplitMetrics; engine: FlyEngine; ms: number } => {
			const engine = createFlyEngine(connectome, { params: { projectionMode: mode } });
			const started = performance.now();
			let trained = 0;
			for (const batch of splits.train) {
				if (batch.excludedReason !== null) continue;
				const texts = new Set(batch.variants.map((variant) => variant.content));
				if (batch.finalContent !== null) texts.add(batch.finalContent);
				const codes: Array<[string, number[]]> = [];
				for (const text of texts) codes.push([text, engine.evaluate(text).activeKcIndexes]);
				trainBatch(engine, batch, new Map(codes));
				trained += 1;
				if (trained % 500 === 0) console.log(`  [${label}] trained ${trained} train batches`);
			}
			const validationRun = runPrequential(engine, splits.validation);
			const metrics = summarizeRun(validationRun, { resamples: args.resamples, seed: args.seed });
			const ms = performance.now() - started;
			console.log(
				`[${label}] validation accuracy ${metrics.accuracy.toFixed(4)} (CI ${metrics.accuracyCi.low.toFixed(3)}–${metrics.accuracyCi.high.toFixed(3)}),` +
				` AUC ${metrics.classAuc.toFixed(4)}, pairs ${metrics.pairs} [${(ms / 1000).toFixed(1)}s]`,
			);
			return { metrics, engine, ms };
		};

		const binaryRun = evaluateMode("binary", "binary");
		const logRun = evaluateMode("log-synapse", "log-synapse");
		const winner = binaryRun.metrics.accuracy >= logRun.metrics.accuracy ? binaryRun : logRun;
		const winnerMode: FlyProjectionMode = winner === binaryRun ? "binary" : "log-synapse";
		console.log(`frozen projection mode: ${winnerMode}`);

		// The winning engine already trained through validation prequentially;
		// the sealed test pass runs exactly once on the newest batches.
		const testStarted = performance.now();
		const testRun = runPrequential(winner.engine, splits.test);
		const testMetrics = summarizeRun(testRun, { resamples: args.resamples, seed: args.seed });
		console.log(`sealed test: accuracy ${testMetrics.accuracy.toFixed(4)} (CI ${testMetrics.accuracyCi.low.toFixed(4)}–${testMetrics.accuracyCi.high.toFixed(4)}), AUC ${testMetrics.classAuc.toFixed(4)}`);

		const deltas = winner.engine.exportSparseDeltas();
		const deltaView = new DataView(deltas.buffer, deltas.byteOffset, deltas.byteLength);
		const weightCount = deltaView.getUint32(4, true);
		const payloadBase64 = Buffer.from(gzipSync(deltas)).toString("base64");

		const result = {
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
			validation: {
				binary: binaryRun.metrics,
				"log-synapse": logRun.metrics,
			},
			winnerMode,
			test: testMetrics,
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
