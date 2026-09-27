/**
 * Fly Tribunal — FT-18R nose registry shared by the calibration scripts.
 *
 * Maps stable CLI ids to nose factories so the matrix runner and the raw
 * historical harness spell candidates identically. Candidate set (program
 * step 0 + 2026-09-27 external consultation): A=old, B=wide, C=style,
 * D=embedder (precomputed vectors), E=char, F=multi.
 */

import {
	createHashNose,
	type FlyNose,
} from "../apps/web/src/lib/fly/fly-engine-core.js";
import {
	createCharHashNose,
	createMultiViewNose,
	createPrecomputedVectorNose,
	createStyleNose,
} from "../apps/web/src/lib/fly/fly-noses.js";

export const FLY_NOSE_IDS = ["old", "wide", "style", "char", "multi", "embedder"] as const;
export type FlyNoseId = (typeof FLY_NOSE_IDS)[number];

export const FLY_NOSE_LABELS: Record<FlyNoseId, string> = {
	old: "A: FT-7 word 1-3-gram hash, 50 channels, per-message max normalization (product default)",
	wide: "B: word 1-3-gram hash, 1024 channels, max normalization (pure width test)",
	style: "C: 22 interpretable style/structure features, absolute [0,1] calibration",
	char: "E: char 3-5-gram hash, 256 channels, absolute log normalization",
	multi: "F: multi-view char(256,log) + word(256,log) + style(22), per-family scaling",
	embedder: "D: precomputed embedding vectors (see scripts/embed-fly-corpus.ts)",
};

export interface ResolvedFlyNose {
	id: FlyNoseId;
	nose: FlyNose;
}

/**
 * Resolve a nose id. `embedder` requires `vectorsFile` — a JSON produced by
 * `scripts/embed-fly-synthetic-corpus.ts` with `{ model, dims, vectors }`.
 */
export async function resolveFlyNose(id: string, options: { vectorsFile?: string } = {}): Promise<ResolvedFlyNose> {
	switch (id) {
		case "old":
			return { id, nose: createHashNose(50) };
		case "wide":
			return { id, nose: createHashNose(1024) };
		case "style":
			return { id, nose: createStyleNose() };
		case "char":
			return { id, nose: createCharHashNose({ channelCount: 256, normalization: "log" }) };
		case "multi":
			return { id, nose: createMultiViewNose({ charChannels: 256, wordChannels: 256, normalization: "log" }) };
		case "embedder": {
			if (options.vectorsFile === undefined) {
				throw new Error("Nose 'embedder' requires --vectors <file> — precompute it with scripts/embed-fly-synthetic-corpus.ts.");
			}
			const raw = JSON.parse(await Bun.file(options.vectorsFile).text()) as {
				model: string;
				dims: number;
				vectors: Record<string, number[]>;
			};
			const vectors = new Map(Object.entries(raw.vectors));
			if (vectors.size === 0) throw new Error(`Vectors file ${options.vectorsFile} contains no vectors.`);
			return { id, nose: createPrecomputedVectorNose(vectors, raw.dims) };
		}
		default:
			throw new Error(`Unknown nose "${id}" — expected one of ${FLY_NOSE_IDS.join(", ")}.`);
	}
}
