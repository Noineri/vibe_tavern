import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  createFlyEngine,
  instantiateLearningSubgraph,
  parseConnectome,
  type FlyConnectome,
  type FlyEngine,
} from "./fly-engine-core.js";

/**
 * Fly Tribunal LIF core (FLY_TRIBUNAL_PLAN FT-7), against FT-1's real fixture
 * builder and binary — never a hand-written lookalike connectome.
 *
 * L1 checklist:
 * 1. Paths: repo root derives from import.meta.dir; fixture scratch path uses
 *    join(tmpdir(), ...); no machine literals.
 * 2. Restores: the only external state is the generated fixture directory,
 *    removed in afterAll; no globals, registries, env, or mocks are patched.
 * 3. Determinism: FT-1 fixture is seeded; every assertion awaits the finished
 *    build/parse/evaluate operation; no sleeps.
 * 4. Platform: node:path derives every path; no separator or OS assumptions.
 * 5. Shared worker pool: no module mocks or mutable global registries.
 * 6. Stable state: assertions inspect completed pure-engine values and its
 *    resettable weight state, never a transient worker frame.
 */

const repoRoot = resolve(import.meta.dir, "../../../../..");
const buildScript = join(repoRoot, "scripts", "build-fly-connectome.ts");
let fixtureDir = "";
let connectome: FlyConnectome;

async function decompressFixture(compressed: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(gunzipSync(compressed));
}

async function compressFixture(raw: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(gzipSync(raw));
}

function freshEngine(): FlyEngine {
  return createFlyEngine(connectome);
}

beforeAll(async () => {
  fixtureDir = join(tmpdir(), `fly-engine-ft7-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("Fly engine FTCB parse and learning-circuit extraction", () => {
  test("parses the FT-1 fixture counts and drops OTHER nodes/edges", () => {
    expect(connectome.neuronCount).toBe(126);
    expect(connectome.edgeCount).toBe(155);

    const subgraph = instantiateLearningSubgraph(connectome);
    // FT-1 fixture's 14 OTHER neurons (including unknown endpoints) never
    // enter the burst circuit; four edges touching them are dropped.
    expect(subgraph.neuronCount).toBe(112);
    expect(subgraph.edgeCount).toBe(151);
    expect(subgraph.olfactoryInputIndexes).toHaveLength(20);
    expect(subgraph.kcIndexes).toHaveLength(60);
    expect(subgraph.mbonIndexes).toHaveLength(8);
    expect(subgraph.globalToSubgraph.some((index) => index === -1)).toBe(true);
  });
});

describe("Fly engine deterministic text encoding", () => {
  test("encodes the same text identically and distinct text into different channel vectors", () => {
    const engine = freshEngine();
    const first = engine.encode("Violet lantern, violet lantern.");
    const repeat = engine.encode("Violet lantern, violet lantern.");
    const other = engine.encode("Marble compass beneath rain.");

    expect(first.registry).toEqual(repeat.registry);
    expect(Array.from(first.channels)).toEqual(Array.from(repeat.channels));
    expect(Array.from(first.channels)).not.toEqual(Array.from(other.channels));
    expect(first.registry.every((entry) => entry.channel >= 0 && entry.channel < 50)).toBe(true);
  });
});

describe("Fly engine plasticity/readout", () => {
  test("PPL1 training raises matching confidence while a disjoint control stays flat", () => {
    const engine = freshEngine();
    const learnedText = "violet lantern harbor";
    const before = engine.evaluate(learnedText);
    expect(before.confidence).toBe(0);
    expect(before.activeKcIndexes.length).toBeGreaterThan(0);

    const trainedKcs = new Set(before.activeKcIndexes);
    const control = [
      "marble compass rain",
      "thunder orchard glass",
      "copper willow horizon",
      "paper comet river",
      "saffron engine meadow",
      "quartz fox midnight",
      "ember violin snow",
      "cedar moon archive",
    ]
      .map((text) => ({ text, evaluation: engine.evaluate(text) }))
      .find(({ evaluation }) => evaluation.activeKcIndexes.every((index) => !trainedKcs.has(index)));
    if (control === undefined) throw new Error("FT-1 fixture did not yield a disjoint KC control pattern.");

    engine.trainText(learnedText, "PPL1", 0.5);
    const after = engine.evaluate(learnedText);
    const controlAfter = engine.evaluate(control.text);

    expect(after.confidence).toBeGreaterThan(before.confidence);
    expect(controlAfter.confidence).toBeCloseTo(control.evaluation.confidence, 10);
  });

  test("driving spans always trace to this message's n-gram/channel registry", () => {
    const engine = freshEngine();
    engine.trainText("violet lantern harbor", "PPL1", 0.5);
    const evaluation = engine.evaluate("violet lantern harbor");

    expect(evaluation.drivingSpans.length).toBeGreaterThan(0);
    for (const span of evaluation.drivingSpans) {
      expect(
        evaluation.registry.some((entry) => entry.ngram === span.ngram && entry.channel === span.channel),
      ).toBe(true);
      expect(span.activeKcGlobalIndexes).toEqual(evaluation.activeKcGlobalIndexes);
    }
  });

  test("resetWeights returns the readout to its binary baseline", () => {
    const engine = freshEngine();
    const text = "violet lantern harbor";
    const baseline = engine.evaluate(text);
    engine.trainText(text, "PPL1", 0.5);
    expect(engine.evaluate(text).confidence).toBeGreaterThan(baseline.confidence);

    engine.resetWeights();
    expect(engine.evaluate(text).confidence).toBeCloseTo(baseline.confidence, 10);
  });

  test("sparse gzip memory round-trips and exponential decay respects infinity", async () => {
    const text = "violet lantern harbor";
    const trained = freshEngine();
    trained.trainText(text, "PPL1", 0.75);
    const beforeDecay = trained.evaluate(text).confidence;
    const payload = await trained.exportGzippedSparseDeltas(compressFixture);

    const restored = freshEngine();
    await restored.importGzippedSparseDeltas(payload, decompressFixture);
    expect(restored.evaluate(text).confidence).toBeCloseTo(beforeDecay, 10);

    restored.applyExponentialDecay(86_400_000, 1);
    expect(restored.evaluate(text).confidence).toBeLessThan(beforeDecay);
    restored.resetWeights();
    await restored.importGzippedSparseDeltas(payload, decompressFixture);
    restored.applyExponentialDecay(86_400_000 * 100, null);
    expect(restored.evaluate(text).confidence).toBeCloseTo(beforeDecay, 10);
  });

  test("PAM calibration offsets shared learned rejection evidence", () => {
    const text = "violet lantern harbor";
    const negativeOnly = freshEngine();
    negativeOnly.trainText(text, "PPL1", 0.5);
    const contrastive = freshEngine();
    contrastive.trainText(text, "PPL1", 0.5);
    contrastive.trainText(text, "PAM", 0.25);

    expect(contrastive.evaluate(text).confidence).toBeLessThan(negativeOnly.evaluate(text).confidence);
  });

  test("a stronger edited-save PAM signal outweighs the implicit keep signal", () => {
    const text = "violet lantern harbor";
    const implicitKeep = freshEngine();
    implicitKeep.trainText(text, "PPL1", 0.5);
    implicitKeep.trainText(text, "PAM", 0.25);
    const editedSave = freshEngine();
    editedSave.trainText(text, "PPL1", 0.5);
    editedSave.trainText(text, "PAM", 0.75);

    expect(editedSave.evaluate(text).confidence).toBeLessThan(implicitKeep.evaluate(text).confidence);
  });
});
