/**
 * Fly Tribunal — FT-18R embedder-vector precompute (candidate D support).
 *
 * Runs every unique text of a synthetic corpus (or any FlyCalibrationBatch
 * list) through a LOCAL Ollama embedding model once, and writes the vectors
 * JSON that `resolveFlyNose("embedder")` consumes:
 *
 *   { model, dims, count, vectors: { [exactText]: number[] } }
 *
 * The engine's evaluate() is synchronous, so the async embedder runs here,
 * offline, before any calibration pass. Nothing leaves the machine.
 *
 * Usage:
 *   bun scripts/embed-fly-synthetic-corpus.ts --corpus <corpus.json>
 *     [--model bge-m3] [--url http://127.0.0.1:11434] [--batch 16]
 *     [--out <vectors.json>]  (default: %TEMP%/fly-embedder-vectors-<model>.json)
 */

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { FlySyntheticBatch } from "./generate-fly-synthetic-corpus.js";

interface CliArgs {
	corpus: string;
	model: string;
	url: string;
	batch: number;
	out: string;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		corpus: "",
		model: "bge-m3",
		url: "http://127.0.0.1:11434",
		batch: 16,
		out: "",
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--corpus") args.corpus = argv[++index] ?? args.corpus;
		else if (arg === "--model") args.model = argv[++index] ?? args.model;
		else if (arg === "--url") args.url = argv[++index] ?? args.url;
		else if (arg === "--batch") args.batch = Number(argv[++index] ?? args.batch);
		else if (arg === "--out") args.out = argv[++index] ?? args.out;
		else throw new Error(`Unknown embedder argument: ${arg}`);
	}
	if (args.corpus === "") throw new Error("--corpus <file> is required.");
	if (args.out === "") args.out = resolve(tmpdir(), `fly-embedder-vectors-${args.model}.json`);
	return args;
}

export async function main(argv: string[]): Promise<void> {
	const args = parseArgs(argv);
	const corpus = JSON.parse(await Bun.file(resolve(args.corpus)).text()) as { batches: FlySyntheticBatch[] };
	const texts = new Set<string>();
	for (const batch of corpus.batches) {
		for (const variant of batch.variants) texts.add(variant.content);
		if (batch.finalContent !== null) texts.add(batch.finalContent);
	}
	const unique = [...texts];
	console.log(`embedding ${unique.length} unique texts with ${args.model} at ${args.url}`);

	const health = await fetch(`${args.url}/api/tags`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
	if (health === null || !health.ok) {
		throw new Error(
			`Ollama is not reachable at ${args.url} — start it first (tray app or "ollama serve"), then rerun.`,
		);
	}

	const vectors: Record<string, number[]> = {};
	let dims = 0;
	const started = performance.now();
	for (let offset = 0; offset < unique.length; offset += args.batch) {
		const chunk = unique.slice(offset, offset + args.batch);
		const response = await fetch(`${args.url}/api/embed`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: args.model, input: chunk }),
			signal: AbortSignal.timeout(120_000),
		});
		if (!response.ok) {
			throw new Error(`Ollama /api/embed failed (${response.status}): ${await response.text()}`);
		}
		const payload = (await response.json()) as { embeddings: number[][] };
		if (payload.embeddings.length !== chunk.length) {
			throw new Error(`Ollama returned ${payload.embeddings.length} embeddings for ${chunk.length} texts.`);
		}
		for (let index = 0; index < chunk.length; index += 1) {
			const vector = payload.embeddings[index]!;
			if (vector.some((value) => !Number.isFinite(value))) {
				throw new Error(`Non-finite embedding for text: ${chunk[index]!.slice(0, 60)}…`);
			}
			if (dims === 0) dims = vector.length;
			else if (vector.length !== dims) {
				throw new Error(`Embedding dims drifted: ${vector.length} after ${dims}.`);
			}
			vectors[chunk[index]!] = vector;
		}
		if ((offset / args.batch) % 10 === 0) {
			console.log(`  ${Math.min(offset + args.batch, unique.length)}/${unique.length} texts (${((performance.now() - started) / 1000).toFixed(0)}s)`);
		}
	}

	const output = { model: args.model, dims, count: unique.length, vectors };
	await writeFile(resolve(args.out), JSON.stringify(output));
	console.log(`wrote ${resolve(args.out)} — ${unique.length} vectors × ${dims} dims (${((performance.now() - started) / 1000).toFixed(0)}s)`);
}

if (import.meta.main) {
	await main(process.argv.slice(2));
}
