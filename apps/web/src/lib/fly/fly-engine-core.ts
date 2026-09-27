/**
 * Pure Fly Tribunal simulation core (FLY_TRIBUNAL_PLAN FT-7).
 *
 * This module deliberately has no Worker, DOM, Cache API, or fetch globals so
 * its binary parser and deterministic learning-circuit simulation run under
 * Bun tests. `fly-worker.ts` supplies browser gzip decompression and owns the
 * message protocol; the UI never instantiates this core directly.
 *
 * Pipeline for one assistant variant:
 * 1. parse the FT-1 `FTCB` gzip artifact through an injected decompressor;
 * 2. retain the olfactory/KC/MBON/DAN/GF learning circuit (drop OTHER);
 * 3. tokenize 1–3 word n-grams, hash them into 50 glomerular channels;
 * 4. run a bounded 10 Hz leaky-integrate-and-fire burst (no idle ticking);
 * 5. take a sparse KC winner set and read learned KC→MBON deltas;
 * 6. return confidence plus channel-backed driving spans for the verdict UI.
 *
 * There is intentionally NO habituation/session repetition detector here.
 * Plasticity is an explicit three-factor lever only; FT-12 decides WHEN a
 * confirmed swipe/edit/continuation is allowed to pull that lever.
 */

// ─── FT-1 binary format ──────────────────────────────────────────────────────

export const FLY_CONNECTOME_MAGIC = 0x42435446; // "FTCB" little-endian
export const FLY_CONNECTOME_FORMAT_VERSION = 1;
const HEADER_BYTES = 24;
const EDGE_BYTES = 12;
const NEURON_BYTES = 5;

/** FT-1 group ids — keep in the exact build-script/manifest order. */
export const FLY_GROUP = {
  OLF_OS: 0,
  OLF_PN: 1,
  OLF_LN: 2,
  KC: 3,
  MBON: 4,
  DAN_PPL1: 5,
  DAN_PAM: 6,
  DAN_OTHER: 7,
  GF: 8,
  OTHER: 9,
} as const;

export type FlyGroupName = keyof typeof FLY_GROUP;
export type FlyDanCluster = "PPL1" | "PAM";

const GROUP_NAMES: readonly FlyGroupName[] = [
  "OLF_OS",
  "OLF_PN",
  "OLF_LN",
  "KC",
  "MBON",
  "DAN_PPL1",
  "DAN_PAM",
  "DAN_OTHER",
  "GF",
  "OTHER",
];

/** Browser/worker-specific gzip implementation injected into the pure parser. */
export type FlyGzipDecompress = (compressed: Uint8Array) => Promise<Uint8Array>;
/** Compression seam for browser workers / deterministic Bun tests. */
export type FlyGzipCompress = (raw: Uint8Array) => Promise<Uint8Array>;

/** Sparse learned-delta payload magic: little-endian "FTWD". */
export const FLY_WEIGHT_DELTA_MAGIC = 0x44575446;
const FLY_WEIGHT_DELTA_HEADER_BYTES = 8;
const FLY_WEIGHT_DELTA_ENTRY_BYTES = 8;
const FLY_DAY_MS = 86_400_000;

export interface FlyConnectome {
  formatVersion: number;
  neuronCount: number;
  edgeCount: number;
  groupCount: number;
  typeCount: number;
  edgePre: Uint32Array;
  edgePost: Uint32Array;
  edgeWeight: Float32Array;
  region: Uint8Array;
  group: Uint16Array;
  typeIndex: Uint16Array;
}

/**
 * Parse one gzip-compressed FT-1 artifact. The decompressor is injected so
 * browser workers use `DecompressionStream("gzip")` while tests use Bun's
 * deterministic `gunzipSync` seam without importing Node APIs into web code.
 */
export async function parseConnectome(
  compressed: Uint8Array,
  decompress: FlyGzipDecompress,
): Promise<FlyConnectome> {
  const raw = await decompress(compressed);
  if (raw.byteLength < HEADER_BYTES) {
    throw new Error("Fly connectome is shorter than its FTCB header.");
  }

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== FLY_CONNECTOME_MAGIC) {
    throw new Error(`Fly connectome magic mismatch: expected FTCB, got 0x${magic.toString(16)}.`);
  }
  const formatVersion = view.getUint16(4, true);
  if (formatVersion !== FLY_CONNECTOME_FORMAT_VERSION) {
    throw new Error(`Unsupported Fly connectome format ${formatVersion}.`);
  }

  const neuronCount = view.getUint32(8, true);
  const edgeCount = view.getUint32(12, true);
  const groupCount = view.getUint32(16, true);
  const typeCount = view.getUint32(20, true);
  if (groupCount !== GROUP_NAMES.length) {
    throw new Error(`Fly connectome group count ${groupCount} does not match FT-1's ${GROUP_NAMES.length}.`);
  }

  const requiredBytes = HEADER_BYTES + edgeCount * EDGE_BYTES + neuronCount * NEURON_BYTES;
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes !== raw.byteLength) {
    throw new Error(`Fly connectome byte length mismatch: expected ${requiredBytes}, got ${raw.byteLength}.`);
  }

  const edgePre = new Uint32Array(edgeCount);
  const edgePost = new Uint32Array(edgeCount);
  const edgeWeight = new Float32Array(edgeCount);
  let offset = HEADER_BYTES;
  for (let index = 0; index < edgeCount; index += 1) {
    const pre = view.getUint32(offset, true);
    const post = view.getUint32(offset + 4, true);
    if (pre >= neuronCount || post >= neuronCount) {
      throw new Error(`Fly connectome edge ${index} references a neuron outside the ${neuronCount}-node graph.`);
    }
    edgePre[index] = pre;
    edgePost[index] = post;
    edgeWeight[index] = view.getFloat32(offset + 8, true);
    offset += EDGE_BYTES;
  }

  const region = new Uint8Array(neuronCount);
  const group = new Uint16Array(neuronCount);
  const typeIndex = new Uint16Array(neuronCount);
  for (let index = 0; index < neuronCount; index += 1) {
    region[index] = view.getUint8(offset);
    const groupId = view.getUint16(offset + 1, true);
    if (groupId >= groupCount) {
      throw new Error(`Fly connectome neuron ${index} has invalid group id ${groupId}.`);
    }
    group[index] = groupId;
    typeIndex[index] = view.getUint16(offset + 3, true);
    offset += NEURON_BYTES;
  }

  return {
    formatVersion,
    neuronCount,
    edgeCount,
    groupCount,
    typeCount,
    edgePre,
    edgePost,
    edgeWeight,
    region,
    group,
    typeIndex,
  };
}

// ─── Learning-circuit subgraph ───────────────────────────────────────────────

/**
 * MCNS contains 166k+ neurons, but the tribunal instantiates only groups
 * 0..8: olfactory input/PN/LN, KC, MBON, all DAN clusters, and GF. `OTHER`
 * never becomes a node here, and every edge touching it is dropped.
 */
export interface FlyLearningSubgraph {
  neuronCount: number;
  edgeCount: number;
  /** Original FT-1 binary index → subgraph index, -1 for dropped OTHER. */
  globalToSubgraph: Int32Array;
  /** Subgraph index → original FT-1 binary index (evidence identity). */
  subgraphToGlobal: Uint32Array;
  region: Uint8Array;
  group: Uint16Array;
  typeIndex: Uint16Array;
  edgePre: Uint32Array;
  edgePost: Uint32Array;
  baseEdgeWeight: Float32Array;
  /** CSR edge lookup: outgoing edge indexes for every subgraph neuron. */
  outgoingOffsets: Uint32Array;
  outgoingEdgeIndexes: Uint32Array;
  /** KC→MBON edge indexes — the only synapses plasticity changes. */
  kcToMbonEdgeIndexes: Uint32Array;
  olfactoryInputIndexes: Uint32Array;
  kcIndexes: Uint32Array;
  mbonIndexes: Uint32Array;
  /**
   * MCNS can contain much larger aggregate synapse counts than snedea's
   * reference graph. We preserve relative weights but graph-normalize them so
   * the largest raw edge equals at most `SYNAPSE_REFERENCE_COUNT` before the
   * reference 0.15 LIF weight scale is applied.
   */
  synapseNormalization: number;
}

/** Raw aggregate-synapse target before the 0.15 LIF scale is applied. */
export const FLY_SYNAPSE_REFERENCE_COUNT = 30;

export function instantiateLearningSubgraph(connectome: FlyConnectome): FlyLearningSubgraph {
  const globalToSubgraph = new Int32Array(connectome.neuronCount);
  globalToSubgraph.fill(-1);
  let neuronCount = 0;
  for (let globalIndex = 0; globalIndex < connectome.neuronCount; globalIndex += 1) {
    if (connectome.group[globalIndex] !== FLY_GROUP.OTHER) {
      globalToSubgraph[globalIndex] = neuronCount;
      neuronCount += 1;
    }
  }

  const subgraphToGlobal = new Uint32Array(neuronCount);
  const region = new Uint8Array(neuronCount);
  const group = new Uint16Array(neuronCount);
  const typeIndex = new Uint16Array(neuronCount);
  const olfactory: number[] = [];
  const kcs: number[] = [];
  const mbons: number[] = [];
  for (let globalIndex = 0; globalIndex < connectome.neuronCount; globalIndex += 1) {
    const subgraphIndex = globalToSubgraph[globalIndex]!;
    if (subgraphIndex < 0) continue;
    const groupId = connectome.group[globalIndex]!;
    subgraphToGlobal[subgraphIndex] = globalIndex;
    region[subgraphIndex] = connectome.region[globalIndex]!;
    group[subgraphIndex] = groupId;
    typeIndex[subgraphIndex] = connectome.typeIndex[globalIndex]!;
    if (groupId === FLY_GROUP.OLF_OS) olfactory.push(subgraphIndex);
    if (groupId === FLY_GROUP.KC) kcs.push(subgraphIndex);
    if (groupId === FLY_GROUP.MBON) mbons.push(subgraphIndex);
  }

  let edgeCount = 0;
  for (let edgeIndex = 0; edgeIndex < connectome.edgeCount; edgeIndex += 1) {
    if (
      globalToSubgraph[connectome.edgePre[edgeIndex]!] >= 0
      && globalToSubgraph[connectome.edgePost[edgeIndex]!] >= 0
    ) {
      edgeCount += 1;
    }
  }

  const edgePre = new Uint32Array(edgeCount);
  const edgePost = new Uint32Array(edgeCount);
  const baseEdgeWeight = new Float32Array(edgeCount);
  let maxAbsWeight = 0;
  let write = 0;
  for (let edgeIndex = 0; edgeIndex < connectome.edgeCount; edgeIndex += 1) {
    const pre = globalToSubgraph[connectome.edgePre[edgeIndex]!];
    const post = globalToSubgraph[connectome.edgePost[edgeIndex]!];
    if (pre < 0 || post < 0) continue;
    const weight = connectome.edgeWeight[edgeIndex]!;
    edgePre[write] = pre;
    edgePost[write] = post;
    baseEdgeWeight[write] = weight;
    maxAbsWeight = Math.max(maxAbsWeight, Math.abs(weight));
    write += 1;
  }

  const outgoingOffsets = new Uint32Array(neuronCount + 1);
  for (const pre of edgePre) outgoingOffsets[pre + 1] += 1;
  for (let index = 1; index < outgoingOffsets.length; index += 1) {
    outgoingOffsets[index] += outgoingOffsets[index - 1]!;
  }
  const outgoingEdgeIndexes = new Uint32Array(edgeCount);
  const cursors = outgoingOffsets.slice(0, neuronCount);
  for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex += 1) {
    const pre = edgePre[edgeIndex]!;
    outgoingEdgeIndexes[cursors[pre]!] = edgeIndex;
    cursors[pre] += 1;
  }

  const kcToMbon: number[] = [];
  for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex += 1) {
    if (group[edgePre[edgeIndex]!] === FLY_GROUP.KC && group[edgePost[edgeIndex]!] === FLY_GROUP.MBON) {
      kcToMbon.push(edgeIndex);
    }
  }

  return {
    neuronCount,
    edgeCount,
    globalToSubgraph,
    subgraphToGlobal,
    region,
    group,
    typeIndex,
    edgePre,
    edgePost,
    baseEdgeWeight,
    outgoingOffsets,
    outgoingEdgeIndexes,
    kcToMbonEdgeIndexes: Uint32Array.from(kcToMbon),
    olfactoryInputIndexes: Uint32Array.from(olfactory),
    kcIndexes: Uint32Array.from(kcs),
    mbonIndexes: Uint32Array.from(mbons),
    synapseNormalization: Math.max(1, maxAbsWeight / FLY_SYNAPSE_REFERENCE_COUNT),
  };
}

// ─── Deterministic stimulus encoder ──────────────────────────────────────────

export const FLY_GLOMERULAR_CHANNEL_COUNT = 50;

export interface FlyNgramRegistryEntry {
  ngram: string;
  channel: number;
  count: number;
  /** √-damped count, max-normalized across this message's channels. */
  activation: number;
}

export interface FlyStimulusEncoding {
  channels: Float32Array;
  registry: FlyNgramRegistryEntry[];
}

/**
 * Stable FNV-1a hash with a fixed seed. It is intentionally not crypto: this
 * is a deterministic feature encoder, not a privacy/security primitive.
 */
function hashNgram(ngram: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < ngram.length; index += 1) {
    hash ^= ngram.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Lowercase Unicode words with internal apostrophes retained; punctuation and
 * whitespace are separators. We emit contiguous 1-, 2-, and 3-grams.
 */
export function tokenizeFlyText(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
}

export function encodeFlyStimulus(text: string): FlyStimulusEncoding {
  const counts = new Map<string, number>();
  const tokens = tokenizeFlyText(text);
  for (let width = 1; width <= 3; width += 1) {
    for (let start = 0; start + width <= tokens.length; start += 1) {
      const ngram = tokens.slice(start, start + width).join(" ");
      counts.set(ngram, (counts.get(ngram) ?? 0) + 1);
    }
  }

  const rawChannels = new Float32Array(FLY_GLOMERULAR_CHANNEL_COUNT);
  const entries = [...counts.entries()]
    .map(([ngram, count]) => ({ ngram, count, channel: hashNgram(ngram) % FLY_GLOMERULAR_CHANNEL_COUNT }))
    .sort((a, b) => a.ngram.localeCompare(b.ngram));
  for (const entry of entries) {
    rawChannels[entry.channel] += Math.sqrt(entry.count);
  }
  const maximum = rawChannels.reduce((current, value) => Math.max(current, value), 0);
  const channels = new Float32Array(FLY_GLOMERULAR_CHANNEL_COUNT);
  if (maximum > 0) {
    for (let channel = 0; channel < channels.length; channel += 1) {
      channels[channel] = rawChannels[channel]! / maximum;
    }
  }
  return {
    channels,
    registry: entries.map((entry) => ({
      ...entry,
      activation: channels[entry.channel]!,
    })),
  };
}

// ─── LIF engine and plasticity seam ──────────────────────────────────────────

/** snedea/flybrain (`sim-worker.js`) baseline, research verified FT-7. */
export const FLY_LIF_DEFAULTS = {
  leak: 0.95,
  threshold: 1,
  refractoryTicks: 3,
  weightScale: 0.15,
  tickRateHz: 10,
  /** Burst-only: no continuous simulation consumes mobile battery. */
  burstTicks: 8,
  /** Max-normalized channel activation × this value stimulates OSNs. */
  stimulusScale: 1.25,
  /** Select the top 10% of positive KC membrane scores as a sparse code. */
  kcSparsity: 0.1,
  /** Maximum registry-backed n-grams surfaced as verdict evidence. */
  maxDrivingSpans: 5,
  /** Positive learned delta per active KC→MBON synapse for confidence 1. */
  learnedDeltaForFullConfidence: 1,
} as const;

export interface FlyEngineParams {
  leak: number;
  threshold: number;
  refractoryTicks: number;
  weightScale: number;
  tickRateHz: number;
  burstTicks: number;
  stimulusScale: number;
  kcSparsity: number;
  maxDrivingSpans: number;
  learnedDeltaForFullConfidence: number;
}

export interface FlyDrivingSpan {
  ngram: string;
  channel: number;
  activation: number;
  /** Global binary KC ids selected by this message's sparse code. */
  activeKcGlobalIndexes: number[];
}

export interface FlyMbonReadout {
  subgraphIndex: number;
  /** Original binary identity retained through subgraph filtering. */
  globalIndex: number;
  /** Manifest type-table label when the worker received it at load time. */
  typeName: string | null;
  activation: number;
}

export interface FlyEvaluation {
  confidence: number;
  registry: FlyNgramRegistryEntry[];
  drivingSpans: FlyDrivingSpan[];
  /** Public only so FT-12 can pass an exact pattern to the plasticity seam. */
  activeKcIndexes: number[];
  activeKcGlobalIndexes: number[];
  mbonReadout: FlyMbonReadout[];
}

export interface FlyEngineOptions {
  /** Manifest type table; optional in core tests, present in worker load. */
  typeNames?: readonly string[];
  params?: Partial<FlyEngineParams>;
}

/**
 * Stateful only in its KC→MBON weight deltas and runtime parameters. Every
 * evaluation's stimulus/LIF arrays are freshly allocated, so messages never
 * leak a repetition/session state into the next verdict.
 */
export class FlyEngine {
  readonly subgraph: FlyLearningSubgraph;
  readonly typeNames: readonly string[];
  private readonly learnedDeltas: Float32Array;
  private params: FlyEngineParams;

  constructor(subgraph: FlyLearningSubgraph, options: FlyEngineOptions = {}) {
    if (subgraph.olfactoryInputIndexes.length === 0 || subgraph.kcIndexes.length === 0 || subgraph.mbonIndexes.length === 0) {
      throw new Error("Fly learning subgraph requires OLF_OS, KC, and MBON neurons.");
    }
    this.subgraph = subgraph;
    this.typeNames = options.typeNames ?? [];
    this.learnedDeltas = new Float32Array(subgraph.edgeCount);
    this.params = { ...FLY_LIF_DEFAULTS, ...options.params };
    this.assertParams(this.params);
  }

  getParams(): FlyEngineParams {
    return { ...this.params };
  }

  /** Runtime equivalent of snedea's `setParams`; all values remain bounded. */
  setParams(params: Partial<FlyEngineParams>): FlyEngineParams {
    const next = { ...this.params, ...params };
    this.assertParams(next);
    this.params = next;
    return this.getParams();
  }

  encode(text: string): FlyStimulusEncoding {
    return encodeFlyStimulus(text);
  }

  evaluate(text: string): FlyEvaluation {
    const stimulus = this.encode(text);
    const { potentials, spikeCounts } = this.runBurst(stimulus.channels);
    const activeKcIndexes = this.selectSparseKcs(potentials, spikeCounts);
    const activeKcGlobalIndexes = activeKcIndexes.map((index) => this.subgraph.subgraphToGlobal[index]!);
    const mbonReadout = this.readMbonActivity(activeKcIndexes, potentials);
    const confidence = this.readLearnedConfidence(activeKcIndexes);
    const drivingSpans = [...stimulus.registry]
      .sort((a, b) => b.activation - a.activation || b.count - a.count || a.ngram.localeCompare(b.ngram))
      .slice(0, this.params.maxDrivingSpans)
      .map((entry) => ({
        ngram: entry.ngram,
        channel: entry.channel,
        activation: entry.activation,
        activeKcGlobalIndexes,
      }));

    return {
      confidence,
      registry: stimulus.registry,
      drivingSpans,
      activeKcIndexes,
      activeKcGlobalIndexes,
      mbonReadout,
    };
  }

  /**
   * Three-factor plasticity lever. PPL1 raises rejection evidence for the
   * active KC→MBON synapses; PAM lowers it. FT-12 owns all behavioral trigger
   * logic (confirmed swipes, edited saves, continuation) and calls this only
   * with already-authorized patterns.
   */
  applyThreeFactor(
    activeKcIndexes: readonly number[],
    danCluster: FlyDanCluster,
    strength: number,
  ): void {
    if (!Number.isFinite(strength) || strength <= 0) {
      throw new Error("Fly three-factor strength must be a positive finite number.");
    }
    const active = new Uint8Array(this.subgraph.neuronCount);
    for (const index of activeKcIndexes) {
      if (this.subgraph.group[index] !== FLY_GROUP.KC) {
        throw new Error(`Fly three-factor pattern includes non-KC neuron ${index}.`);
      }
      active[index] = 1;
    }
    const direction = danCluster === "PPL1" ? 1 : -1;
    for (const edgeIndex of this.subgraph.kcToMbonEdgeIndexes) {
      if (active[this.subgraph.edgePre[edgeIndex]!] === 1) {
        this.learnedDeltas[edgeIndex] += direction * strength;
      }
    }
  }

  /** Convenience seam for a message event: evaluate its exact pattern, then train it. */
  trainText(text: string, danCluster: FlyDanCluster, strength: number): FlyEvaluation {
    const evaluation = this.evaluate(text);
    this.applyThreeFactor(evaluation.activeKcIndexes, danCluster, strength);
    return evaluation;
  }

  /** Amnesty/scope switch: discard all learned deltas and return to FT-1 baseline. */
  resetWeights(): void {
    this.learnedDeltas.fill(0);
  }

  /**
   * Serialize nonzero KC→MBON deltas as `(edgeIndex:u32, delta:f32)` pairs.
   * The worker compresses this deterministic binary payload before it crosses
   * the API as base64; other edge classes are intentionally never persisted.
   */
  exportSparseDeltas(): Uint8Array {
    const entries: Array<{ edgeIndex: number; delta: number }> = [];
    for (const edgeIndex of this.subgraph.kcToMbonEdgeIndexes) {
      const delta = this.learnedDeltas[edgeIndex]!;
      if (delta !== 0) entries.push({ edgeIndex, delta });
    }
    const bytes = new Uint8Array(FLY_WEIGHT_DELTA_HEADER_BYTES + entries.length * FLY_WEIGHT_DELTA_ENTRY_BYTES);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, FLY_WEIGHT_DELTA_MAGIC, true);
    view.setUint32(4, entries.length, true);
    let offset = FLY_WEIGHT_DELTA_HEADER_BYTES;
    for (const entry of entries) {
      view.setUint32(offset, entry.edgeIndex, true);
      view.setFloat32(offset + 4, entry.delta, true);
      offset += FLY_WEIGHT_DELTA_ENTRY_BYTES;
    }
    return bytes;
  }

  /** Replace the learned state from a validated sparse payload. */
  importSparseDeltas(bytes: Uint8Array): void {
    if (bytes.byteLength < FLY_WEIGHT_DELTA_HEADER_BYTES) {
      throw new Error("Fly weight payload is shorter than its header.");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== FLY_WEIGHT_DELTA_MAGIC) {
      throw new Error("Fly weight payload magic mismatch.");
    }
    const count = view.getUint32(4, true);
    const expectedBytes = FLY_WEIGHT_DELTA_HEADER_BYTES + count * FLY_WEIGHT_DELTA_ENTRY_BYTES;
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes !== bytes.byteLength) {
      throw new Error("Fly weight payload length mismatch.");
    }
    this.learnedDeltas.fill(0);
    const validPlasticEdge = new Uint8Array(this.subgraph.edgeCount);
    for (const edgeIndex of this.subgraph.kcToMbonEdgeIndexes) validPlasticEdge[edgeIndex] = 1;
    let offset = FLY_WEIGHT_DELTA_HEADER_BYTES;
    for (let index = 0; index < count; index += 1) {
      const edgeIndex = view.getUint32(offset, true);
      const delta = view.getFloat32(offset + 4, true);
      if (edgeIndex >= this.subgraph.edgeCount || validPlasticEdge[edgeIndex] !== 1 || !Number.isFinite(delta)) {
        throw new Error(`Fly weight payload entry ${index} is invalid.`);
      }
      this.learnedDeltas[edgeIndex] = delta;
      offset += FLY_WEIGHT_DELTA_ENTRY_BYTES;
    }
  }

  /** Encode + gzip the sparse payload for the base64 API memory contract. */
  async exportGzippedSparseDeltas(compress: FlyGzipCompress): Promise<string> {
    return bytesToBase64(await compress(this.exportSparseDeltas()));
  }

  /** Decode + gunzip a persisted sparse payload; null is the fresh baseline. */
  async importGzippedSparseDeltas(weights: string | null, decompress: FlyGzipDecompress): Promise<void> {
    if (weights === null) {
      this.resetWeights();
      return;
    }
    this.importSparseDeltas(await decompress(base64ToBytes(weights)));
  }

  /**
   * Approximate per-precedent lifetime with exponential decay of the summed
   * delta field: `delta *= exp(-elapsedMs / (lifetimeDays * dayMs))`.
   * The compact flat-delta encoding has no per-event timestamps, so this is
   * applied on load and persistence ticks rather than to individual events.
   */
  applyExponentialDecay(elapsedMs: number, lifetimeDays: number | null): number {
    if (lifetimeDays === null) return 1;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || !Number.isFinite(lifetimeDays) || lifetimeDays <= 0) {
      throw new Error("Fly decay requires nonnegative elapsed time and a positive lifetime.");
    }
    const factor = Math.exp(-elapsedMs / (lifetimeDays * FLY_DAY_MS));
    for (const edgeIndex of this.subgraph.kcToMbonEdgeIndexes) {
      this.learnedDeltas[edgeIndex] *= factor;
    }
    return factor;
  }

  private runBurst(channels: Float32Array): { potentials: Float32Array; spikeCounts: Uint16Array } {
    const count = this.subgraph.neuronCount;
    const potentials = new Float32Array(count);
    const currentInput = new Float32Array(count);
    let nextInput = new Float32Array(count);
    const refractory = new Uint8Array(count);
    const spikeCounts = new Uint16Array(count);

    for (let channel = 0; channel < channels.length; channel += 1) {
      const activation = channels[channel]!;
      if (activation === 0) continue;
      const olfactoryIndex = this.subgraph.olfactoryInputIndexes[channel % this.subgraph.olfactoryInputIndexes.length]!;
      currentInput[olfactoryIndex] += activation * this.params.stimulusScale;
    }

    for (let tick = 0; tick < this.params.burstTicks; tick += 1) {
      const spikes = new Uint8Array(count);
      for (let neuron = 0; neuron < count; neuron += 1) {
        if (refractory[neuron] > 0) {
          refractory[neuron] -= 1;
          potentials[neuron] = 0;
          continue;
        }
        const potential = potentials[neuron]! * this.params.leak + currentInput[neuron]!;
        if (potential >= this.params.threshold) {
          spikes[neuron] = 1;
          spikeCounts[neuron] += 1;
          potentials[neuron] = 0;
          refractory[neuron] = this.params.refractoryTicks;
        } else {
          potentials[neuron] = potential;
        }
      }

      nextInput.fill(0);
      for (let pre = 0; pre < count; pre += 1) {
        if (spikes[pre] === 0) continue;
        const start = this.subgraph.outgoingOffsets[pre]!;
        const end = this.subgraph.outgoingOffsets[pre + 1]!;
        for (let cursor = start; cursor < end; cursor += 1) {
          const edgeIndex = this.subgraph.outgoingEdgeIndexes[cursor]!;
          const post = this.subgraph.edgePost[edgeIndex]!;
          nextInput[post] += this.synapticWeight(edgeIndex) * this.params.weightScale;
        }
      }
      currentInput.set(nextInput);
    }

    return { potentials, spikeCounts };
  }

  private synapticWeight(edgeIndex: number): number {
    return (this.subgraph.baseEdgeWeight[edgeIndex]! + this.learnedDeltas[edgeIndex]!) / this.subgraph.synapseNormalization;
  }

  private selectSparseKcs(potentials: Float32Array, spikeCounts: Uint16Array): number[] {
    const candidates = Array.from(this.subgraph.kcIndexes, (index) => ({
      index,
      // Spikes dominate, then subthreshold membrane potential ranks ties.
      score: spikeCounts[index]! * this.params.threshold + potentials[index]!,
    })).filter((candidate) => candidate.score > 0);
    candidates.sort((a, b) => b.score - a.score || a.index - b.index);
    const wanted = Math.max(1, Math.ceil(this.subgraph.kcIndexes.length * this.params.kcSparsity));
    return candidates.slice(0, wanted).map((candidate) => candidate.index);
  }

  private readMbonActivity(activeKcIndexes: readonly number[], potentials: Float32Array): FlyMbonReadout[] {
    const active = new Uint8Array(this.subgraph.neuronCount);
    for (const index of activeKcIndexes) active[index] = 1;
    const activationByMbon = new Float32Array(this.subgraph.neuronCount);
    for (const edgeIndex of this.subgraph.kcToMbonEdgeIndexes) {
      const kc = this.subgraph.edgePre[edgeIndex]!;
      if (active[kc] === 0) continue;
      const mbon = this.subgraph.edgePost[edgeIndex]!;
      activationByMbon[mbon] += Math.max(0, this.synapticWeight(edgeIndex)) + Math.max(0, potentials[kc]!);
    }
    return Array.from(this.subgraph.mbonIndexes, (index) => ({
      subgraphIndex: index,
      globalIndex: this.subgraph.subgraphToGlobal[index]!,
      typeName: this.typeNames[this.subgraph.typeIndex[index]!] ?? null,
      activation: activationByMbon[index]!,
    })).filter((entry) => entry.activation > 0);
  }

  private readLearnedConfidence(activeKcIndexes: readonly number[]): number {
    if (activeKcIndexes.length === 0) return 0;
    const active = new Uint8Array(this.subgraph.neuronCount);
    for (const index of activeKcIndexes) active[index] = 1;
    let learnedPositive = 0;
    let activeSynapses = 0;
    for (const edgeIndex of this.subgraph.kcToMbonEdgeIndexes) {
      if (active[this.subgraph.edgePre[edgeIndex]!] === 0) continue;
      activeSynapses += 1;
      learnedPositive += Math.max(0, this.learnedDeltas[edgeIndex]!);
    }
    if (activeSynapses === 0) return 0;
    return clamp(learnedPositive / (activeSynapses * this.params.learnedDeltaForFullConfidence), 0, 1);
  }

  private assertParams(params: FlyEngineParams): void {
    if (!Number.isFinite(params.leak) || params.leak < 0 || params.leak > 1) throw new Error("Fly LIF leak must be between 0 and 1.");
    if (!Number.isFinite(params.threshold) || params.threshold <= 0) throw new Error("Fly LIF threshold must be positive.");
    if (!Number.isInteger(params.refractoryTicks) || params.refractoryTicks < 0 || params.refractoryTicks > 255) throw new Error("Fly LIF refractory ticks must be an integer from 0 to 255.");
    if (!Number.isFinite(params.weightScale) || params.weightScale <= 0) throw new Error("Fly LIF weight scale must be positive.");
    if (!Number.isFinite(params.tickRateHz) || params.tickRateHz <= 0) throw new Error("Fly LIF tick rate must be positive.");
    if (!Number.isInteger(params.burstTicks) || params.burstTicks < 1 || params.burstTicks > 100) throw new Error("Fly LIF burst ticks must be an integer from 1 to 100.");
    if (!Number.isFinite(params.stimulusScale) || params.stimulusScale <= 0) throw new Error("Fly stimulus scale must be positive.");
    if (!Number.isFinite(params.kcSparsity) || params.kcSparsity <= 0 || params.kcSparsity > 1) throw new Error("Fly KC sparsity must be in (0, 1].");
    if (!Number.isInteger(params.maxDrivingSpans) || params.maxDrivingSpans < 1) throw new Error("Fly driving-span limit must be a positive integer.");
    if (!Number.isFinite(params.learnedDeltaForFullConfidence) || params.learnedDeltaForFullConfidence <= 0) throw new Error("Fly learned-delta normalization must be positive.");
  }
}

export function createFlyEngine(connectome: FlyConnectome, options: FlyEngineOptions = {}): FlyEngine {
  return new FlyEngine(instantiateLearningSubgraph(connectome), options);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
