import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  FLY_GROUP,
  FLY_WEIGHT_DELTA_MAGIC,
  FlyEngine,
  instantiateLearningSubgraph,
  parseConnectome,
  type FlyConnectome,
  type FlyLearningSubgraph,
} from "./fly-engine-core.js";

/**
 * FT-15 characterization against the committed MCNS artifact, deliberately
 * separate from the FT-1 synthetic fixture suite. FT-16 replaces the inert
 * activation path and must update only the explicitly marked defect pin.
 *
 * L1 checklist:
 * 1. Paths: artifact path derives from import.meta.dir through node:path; no
 *    machine literals or CWD assumptions.
 * 2. Restores: no globals, environment, registries, mocks, or external state
 *    are changed.
 * 3. Determinism: the artifact loads once to a completed pure-engine state;
 *    no waits, timers, or sleeps are used.
 * 4. Platform: node:path builds paths without separator assumptions.
 * 5. Shared worker pool: no module mocks or mutable process-global state.
 * 6. Stable state: assertions inspect parsed graph data and completed engine
 *    evaluations, never a transient worker response.
 */

const repoRoot = resolve(import.meta.dir, "../../../../..");
const realArtifactPath = join(repoRoot, "services", "api", "assets", "fly", "connectome.bin.gz");
const representativeText = "she smiled slowly, tracing her fingers along the windowsill";

let connectome: FlyConnectome;
let subgraph: FlyLearningSubgraph;
let loadAndParseMs = 0;

async function decompressRealArtifact(compressed: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(gunzipSync(compressed));
}

function freshEngine(): FlyEngine {
  return new FlyEngine(subgraph);
}

function countGroup(group: number): number {
  return Array.from(subgraph.group).filter((groupId) => groupId === group).length;
}

beforeAll(async () => {
  const startedAt = performance.now();
  const compressed = new Uint8Array(await readFile(realArtifactPath));
  connectome = await parseConnectome(compressed, decompressRealArtifact);
  loadAndParseMs = performance.now() - startedAt;
  subgraph = instantiateLearningSubgraph(connectome);
});

describe("Fly engine real MCNS artifact characterization (FT-15)", () => {
  test("parses the committed MCNS learning subgraph with its stable group counts", () => {
    expect(loadAndParseMs).toBeGreaterThan(0);
    expect(connectome.neuronCount).toBe(166_700);
    expect(connectome.edgeCount).toBe(6_242_118);
    expect(subgraph.neuronCount).toBe(8_402);
    expect(subgraph.edgeCount).toBe(246_716);
    expect(countGroup(FLY_GROUP.OLF_OS)).toBe(2_755);
    expect(countGroup(FLY_GROUP.OLF_PN)).toBe(700);
    expect(countGroup(FLY_GROUP.OLF_LN)).toBe(444);
    expect(countGroup(FLY_GROUP.KC)).toBe(4_064);
    expect(countGroup(FLY_GROUP.MBON)).toBe(97);
    expect(countGroup(FLY_GROUP.DAN_PPL1)).toBe(16);
    expect(countGroup(FLY_GROUP.DAN_PAM)).toBe(316);
    expect(countGroup(FLY_GROUP.DAN_OTHER)).toBe(8);
    expect(countGroup(FLY_GROUP.GF)).toBe(2);
  });

  test("encodes representative text deterministically on independent real-artifact engines", () => {
    const first = freshEngine().encode(representativeText);
    const second = freshEngine().encode(representativeText);

    expect(first.channels.some((activation) => activation > 0)).toBe(true);
    expect(Array.from(first.channels)).toEqual(Array.from(second.channels));
    expect(first.registry).toEqual(second.registry);
  });

  test("pins the known inert real-artifact activation defect before FT-16 repairs it", () => {
    const engine = freshEngine();
    const beforeTraining = engine.evaluate(representativeText);

    expect(beforeTraining.activeKcIndexes).toHaveLength(0);
    expect(beforeTraining.mbonReadout).toHaveLength(0);
    expect(beforeTraining.confidence).toBe(0);

    engine.trainText(representativeText, "PPL1", 0.5);
    const afterTraining = engine.evaluate(representativeText);
    const weights = engine.exportSparseDeltas();
    const header = new DataView(weights.buffer, weights.byteOffset, weights.byteLength);

    expect(afterTraining.activeKcIndexes).toHaveLength(0);
    expect(afterTraining.mbonReadout).toHaveLength(0);
    expect(afterTraining.confidence).toBe(0);
    expect(weights.byteLength).toBe(8);
    expect(header.getUint32(0, true)).toBe(FLY_WEIGHT_DELTA_MAGIC);
    expect(header.getUint32(4, true)).toBe(0);
  });

  test("keeps empty and whitespace text without channels or active Kenyon cells", () => {
    for (const text of ["", " \n\t "]) {
      const engine = freshEngine();
      const encoding = engine.encode(text);
      const evaluation = engine.evaluate(text);

      expect(encoding.channels.every((activation) => activation === 0)).toBe(true);
      expect(evaluation.activeKcIndexes).toHaveLength(0);
    }
  });
});
