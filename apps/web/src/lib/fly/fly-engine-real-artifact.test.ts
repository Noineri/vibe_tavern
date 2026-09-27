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
 * FT-15/FT-16/FT-17 characterization against the committed MCNS artifact,
 * deliberately separate from the FT-1 synthetic fixture suite. FT-15 pinned
 * the inert activation defect (0 active KCs, empty FTWD); FT-16 replaced the
 * OSN→LIF gate with the connectome-backed FlyHash projection; FT-17 pins the
 * downstream LIF burst those KC codes seed: real MBON spikes, baseline-
 * relative confidence (fresh fly exactly 0), PAM evidence pulling the burst
 * response below baseline, the structural GF silence, and overlap-
 * proportional generalization to minimally overlapping controls.
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
const variantText = "she smiled slowly, tracing her fingers along the dusty windowsill";
const disjointText = "quartz fox midnight cedar archive ember violin snow";

/** Winner-take-all quota on the real KC population: ceil(4,064 × 0.10). */
const realKcQuota = 407;

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

describe("Fly engine real MCNS artifact characterization (FT-15/FT-16/FT-17)", () => {
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

  test("selects exactly the 407-KC winner-take-all code for representative text", () => {
    const first = freshEngine().evaluate(representativeText);
    const second = freshEngine().evaluate(representativeText);

    expect(first.activeKcIndexes).toHaveLength(realKcQuota);
    expect([...first.activeKcIndexes].sort((a, b) => a - b)).toEqual(
      [...second.activeKcIndexes].sort((a, b) => a - b),
    );

    // A sparse multi-channel stimulus reaches fewer KCs than the quota and
    // yields a shorter code rather than padding with silent KCs. (A
    // single-word text can hash entirely onto a PN cohort with no calyx
    // projection and legitimately yield zero KCs — honest connectome
    // behavior, so the sparse pin uses a multi-channel stimulus.)
    const sparse = freshEngine().evaluate("the rain falls softly");
    expect(sparse.activeKcIndexes.length).toBeGreaterThan(0);
    expect(sparse.activeKcIndexes.length).toBeLessThan(realKcQuota);
  });

  test("log-synapse projection mass keeps the same deterministic quota", () => {
    const engine = freshEngine();
    engine.setParams({ projectionMode: "log-synapse" });
    const evaluation = engine.evaluate(representativeText);
    expect(evaluation.activeKcIndexes).toHaveLength(realKcQuota);

    const repeat = freshEngine();
    repeat.setParams({ projectionMode: "log-synapse" });
    expect([...evaluation.activeKcIndexes].sort((a, b) => a - b)).toEqual(
      [...repeat.evaluate(representativeText).activeKcIndexes].sort((a, b) => a - b),
    );
  });

  test("similar variants share more of the KC code than disjoint text", () => {
    const engine = freshEngine();
    const base = engine.evaluate(representativeText).activeKcIndexes;
    const variant = engine.evaluate(variantText).activeKcIndexes;
    const disjoint = engine.evaluate(disjointText).activeKcIndexes;
    const overlapWith = (other: readonly number[]): number => {
      const theirs = new Set(other);
      return base.filter((index) => theirs.has(index)).length;
    };

    expect(overlapWith(variant)).toBeGreaterThan(overlapWith(disjoint));
  });

  test("training on the live KC code writes plastic deltas and raises learned confidence", () => {
    const engine = freshEngine();
    const before = engine.evaluate(representativeText);
    expect(before.confidence).toBe(0);
    expect(before.mbonReadout.length).toBeGreaterThan(0);
    // Evidence the LIF burst actually fires, not just sub-threshold drift.
    expect(before.mbonReadout.some((entry) => entry.spikes > 0)).toBe(true);

    engine.trainText(representativeText, "PPL1", 0.5);
    const after = engine.evaluate(representativeText);
    expect(after.confidence).toBeGreaterThan(0);
    // One rejection moves the burst response UP from the fresh baseline.
    const burstResponse = (evaluation: ReturnType<FlyEngine["evaluate"]>) =>
      evaluation.mbonReadout.reduce((total, entry) => total + entry.activation, 0);
    expect(burstResponse(after)).toBeGreaterThan(burstResponse(before));

    const weights = engine.exportSparseDeltas();
    const header = new DataView(weights.buffer, weights.byteOffset, weights.byteLength);
    const count = header.getUint32(4, true);
    expect(header.getUint32(0, true)).toBe(FLY_WEIGHT_DELTA_MAGIC);
    expect(count).toBeGreaterThan(0);
    expect(weights.byteLength).toBe(8 + count * 8);
  });

  test("PAM evidence lowers the burst response below the fresh baseline", () => {
    const engine = freshEngine();
    const before = engine.evaluate(representativeText);
    engine.trainText(representativeText, "PAM", 0.5);
    const after = engine.evaluate(representativeText);

    expect(after.confidence).toBe(0);
    const burstResponse = (evaluation: ReturnType<FlyEngine["evaluate"]>) =>
      evaluation.mbonReadout.reduce((total, entry) => total + entry.activation, 0);
    expect(burstResponse(after)).toBeLessThan(burstResponse(before));
  });

  test("generalization scales with KC-code overlap: a minimal-overlap control stays far below the trained text", () => {
    const engine = freshEngine();
    const trainedCode = new Set(engine.evaluate(representativeText).activeKcIndexes);
    // Hub Kenyon cells collect from many glomeruli, so every strongly driven
    // 407-code shares a core with every other (measured: 37/407 for this
    // control, 178/407 for the vocabulary-disjoint text). Confidence leak is
    // proportional to overlap — similarity semantics — and FT-18's
    // false-positive metric quantifies it on real swipes. Exact zero-overlap
    // flatness is pinned by the fixture suite, where codes can be disjoint.
    const controlText = "mining lamps flicker underground";
    const controlCode = engine.evaluate(controlText).activeKcIndexes;
    const overlap = controlCode.filter((index) => trainedCode.has(index)).length;
    expect(overlap).toBeGreaterThan(0);
    expect(overlap / controlCode.length).toBeLessThan(0.15);

    engine.trainText(representativeText, "PPL1", 0.5);
    const trainedConfidence = engine.evaluate(representativeText).confidence;
    const controlConfidence = engine.evaluate(controlText).confidence;
    expect(controlConfidence).toBeGreaterThan(0);
    expect(controlConfidence).toBeLessThan(trainedConfidence / 3);
  });

  test("GF is structurally silent: nothing in the learning subgraph feeds it", () => {
    expect(countGroup(FLY_GROUP.GF)).toBe(2);
    let gfIncomingEdges = 0;
    for (let edgeIndex = 0; edgeIndex < subgraph.edgeCount; edgeIndex += 1) {
      if (subgraph.group[subgraph.edgePost[edgeIndex]!] === FLY_GROUP.GF) gfIncomingEdges += 1;
    }
    // MCNS GF inputs (912 of them) all come from the OTHER group, which the
    // learning circuit drops — the flourish is structurally impossible.
    expect(gfIncomingEdges).toBe(0);
    for (const text of [representativeText, variantText, disjointText]) {
      const engine = freshEngine();
      engine.trainText(text, "PPL1", 0.5);
      expect(engine.evaluate(text).gfSpikeCount).toBe(0);
    }
  });

  test("the downstream burst is deterministic across independent engines", () => {
    const first = freshEngine().evaluate(representativeText);
    const second = freshEngine().evaluate(representativeText);

    expect(first.confidence).toBe(second.confidence);
    expect(first.gfSpikeCount).toBe(second.gfSpikeCount);
    expect(first.mbonReadout).toEqual(second.mbonReadout);
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
