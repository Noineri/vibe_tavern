/**
 * Pure Fly Tribunal simulation core (FLY_TRIBUNAL_PLAN FT-7).
 *
 * This module deliberately has no Worker, DOM, Cache API, or fetch globals so
 * its binary parser and deterministic learning-circuit simulation run under
 * Bun tests. `fly-worker.ts` supplies browser gzip decompression and owns the
 * message protocol; the UI never instantiates this core directly.
 *
 * Pipeline for one assistant variant (FT-16 hybrid activation):
 * 1. parse the FT-1 `FTCB` gzip artifact through an injected decompressor;
 * 2. retain the olfactory/KC/MBON/DAN/GF learning circuit (drop OTHER);
 * 3. tokenize 1–3 word n-grams, hash them into 50 glomerular channels;
 * 4. map each channel onto a real glomerular PN-type cohort and project the
 *    cohort activity through the actual PN→KC edges (degree-normalized),
 *    keeping the strongest 10% as a winner-take-all KC code (FlyHash);
 * 5. seed those KCs as the tick-zero spike pattern of a bounded LIF burst
 *    over the actual downstream KC/MBON/DAN/GF edges (FT-17);
 * 6. derive confidence from the learned change in MBON burst response
 *    relative to the fresh baseline and return it with channel-backed
 *    driving spans for the verdict UI.
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
  /**
   * √-damped channel mass scaled by the nose's normalization mode: `max`
   * keeps [0, 1] per message, `log` is an absolute log scale, `none` is the
   * raw damped mass (unbounded).
   */
  activation: number;
}

export interface FlyStimulusEncoding {
  channels: Float32Array;
  registry: FlyNgramRegistryEntry[];
}

/**
 * Stable FNV-1a hash with a fixed seed. It is intentionally not crypto: this
 * is a deterministic feature encoder, not a privacy/security primitive.
 * Exported for the calibration noses (fly-noses.ts) so all families hash
 * with the same primitive.
 */
export function hashNgram(ngram: string): number {
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

/**
 * FT-18R normalization axis: how per-channel √-damped hash mass becomes the
 * activations the projection consumes. Engine fact motivating the axis: the
 * downstream burst consumes only the WTA KC SET (membership, not magnitude),
 * so a per-message common rescale cannot change the code — `max` is exactly
 * such a rescale (rank-preserving), `log` nonlinearly compresses dominant
 * channels (rank-shifting: weak channels' cohorts win relatively more KCs),
 * `none` passes the raw damped mass through unchanged.
 */
export const FLY_HASH_NORMALIZATION_MODES = ["max", "log", "none"] as const;
export type FlyHashNormalization = (typeof FLY_HASH_NORMALIZATION_MODES)[number];

/** `log` saturation: a channel reaches activation 1 at √-damped mass 12 (~144 raw gram hits). */
export const FLY_HASH_LOG_SATURATION = 12;

export function applyFlyHashNormalization(rawChannels: Float32Array, mode: FlyHashNormalization): Float32Array {
  if (mode === "none") return rawChannels;
  const channels = new Float32Array(rawChannels.length);
  if (mode === "log") {
    const scale = Math.log1p(FLY_HASH_LOG_SATURATION);
    for (let channel = 0; channel < channels.length; channel += 1) {
      channels[channel] = Math.min(1, Math.log1p(rawChannels[channel]!) / scale);
    }
    return channels;
  }
  let maximum = 0;
  for (const value of rawChannels) {
    if (value > maximum) maximum = value;
  }
  if (maximum > 0) {
    for (let channel = 0; channel < channels.length; channel += 1) {
      channels[channel] = rawChannels[channel]! / maximum;
    }
  }
  return channels;
}

/**
 * Parameterized hash-nose core shared by the FT-7 default (50 channels, max
 * normalization) and calibration variants with other channel counts and
 * normalization modes (FT-18R program step 0). Exported so the multi-view
 * calibration nose reuses the exact word-family semantics.
 */
export function encodeHashStimulus(
  text: string,
  channelCount: number,
  normalization: FlyHashNormalization = "max",
): FlyStimulusEncoding {
  const counts = new Map<string, number>();
  const tokens = tokenizeFlyText(text);
  for (let width = 1; width <= 3; width += 1) {
    for (let start = 0; start + width <= tokens.length; start += 1) {
      const ngram = tokens.slice(start, start + width).join(" ");
      counts.set(ngram, (counts.get(ngram) ?? 0) + 1);
    }
  }

  const rawChannels = new Float32Array(channelCount);
  const entries = [...counts.entries()]
    .map(([ngram, count]) => ({ ngram, count, channel: hashNgram(ngram) % channelCount }))
    .sort((a, b) => a.ngram.localeCompare(b.ngram));
  for (const entry of entries) {
    rawChannels[entry.channel] += Math.sqrt(entry.count);
  }
  const channels = applyFlyHashNormalization(rawChannels, normalization);
  return {
    channels,
    registry: entries.map((entry) => ({
      ...entry,
      activation: channels[entry.channel]!,
    })),
  };
}

export function encodeFlyStimulus(text: string): FlyStimulusEncoding {
  return encodeHashStimulus(text, FLY_GLOMERULAR_CHANNEL_COUNT);
}

/**
 * The fly's "nose": a swappable stimulus encoder (FT-18R program step 0).
 * Text becomes glomerular channel activations plus the evidence registry
 * that backs driving spans; everything downstream (PN→KC projection, WTA,
 * LIF, plasticity) is nose-agnostic. Calibration swaps noses to test whether
 * the representation or the labels explain the FT-18 chance result.
 */
export interface FlyNose {
  /** Channels this nose emits; the projection spreads them across PN cohorts. */
  readonly channelCount: number;
  encode(text: string): FlyStimulusEncoding;
}

/**
 * The FT-7 default nose: 1–3-gram FNV-1a hash into glomerular channels.
 * `normalization` defaults to the FT-7 per-message max rescale so the
 * product path stays bit-identical; calibration runs pass other modes.
 */
export function createHashNose(
  channelCount: number = FLY_GLOMERULAR_CHANNEL_COUNT,
  normalization: FlyHashNormalization = "max",
): FlyNose {
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 100_000) {
    throw new Error("Fly hash nose channel count must be an integer in [1, 100000].");
  }
  if (!(FLY_HASH_NORMALIZATION_MODES as readonly string[]).includes(normalization)) {
    throw new Error(`Fly hash nose normalization must be one of ${FLY_HASH_NORMALIZATION_MODES.join(", ")}.`);
  }
  return {
    channelCount,
    encode: (text: string): FlyStimulusEncoding => encodeHashStimulus(text, channelCount, normalization),
  };
}

// ─── Engine parameters, projection, and plasticity seam ─────────────────────

/**
 * FT-16 projection edge-mass modes for the PN→KC FlyHash expansion.
 * `binary` counts every presynaptic edge as 1; `log-synapse` weighs each edge
 * by `log1p(|synapseCount|)`. Both are degree-normalized per KC so heavily
 * connected KCs do not dominate the winner-take-all ranking. FT-18 freezes
 * the winner on the validation partition; do not tune it by eye.
 */
export const FLY_PROJECTION_MODES = ["binary", "log-synapse"] as const;
export type FlyProjectionMode = (typeof FLY_PROJECTION_MODES)[number];

/**
 * snedea/flybrain (`sim-worker.js`) LIF constants (FT-7). Since FT-16 the LIF
 * burst no longer gates text→KC activation; FT-17 runs it downstream over
 * the real KC/MBON/DAN/GF edges, seeded by the WTA KC code at tick zero.
 */
export const FLY_LIF_DEFAULTS = {
  leak: 0.95,
  threshold: 1,
  refractoryTicks: 3,
  weightScale: 0.15,
  tickRateHz: 10,
  /** Burst-only: no continuous simulation consumes mobile battery. */
  burstTicks: 8,
  /** Winner-take-all fraction of the KC population in the sparse code. */
  kcSparsity: 0.1,
  /** Maximum registry-backed n-grams surfaced as verdict evidence. */
  maxDrivingSpans: 5,
  /** Positive learned delta per active KC→MBON synapse for confidence 1. */
  learnedDeltaForFullConfidence: 1,
  /** PN→KC projection edge mass; see `FLY_PROJECTION_MODES`. */
  projectionMode: "binary",
} as const;

export interface FlyEngineParams {
  leak: number;
  threshold: number;
  refractoryTicks: number;
  weightScale: number;
  tickRateHz: number;
  burstTicks: number;
  kcSparsity: number;
  maxDrivingSpans: number;
  learnedDeltaForFullConfidence: number;
  projectionMode: FlyProjectionMode;
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
  /** Spikes this MBON fired during the burst (evidence LIF actually fires). */
  spikes: number;
}

export interface FlyEvaluation {
  confidence: number;
  registry: FlyNgramRegistryEntry[];
  drivingSpans: FlyDrivingSpan[];
  /** Public only so FT-12 can pass an exact pattern to the plasticity seam. */
  activeKcIndexes: number[];
  activeKcGlobalIndexes: number[];
  mbonReadout: FlyMbonReadout[];
  /** GF spikes from the burst; structurally 0 on MCNS (all GF inputs are OTHER). */
  gfSpikeCount: number;
}

/** One downstream LIF burst outcome (FT-17); feeds confidence and readout. */
interface FlyBurstResult {
  /** Integrated positive potential per MBON across the burst. */
  mbonIntegrated: Float32Array;
  mbonSpikes: Uint16Array;
  /** Σ integrated positive MBON potential — the confidence signal carrier. */
  response: number;
  gfSpikes: number;
}

export interface FlyEngineOptions {
  /** Manifest type table; optional in core tests, present in worker load. */
  typeNames?: readonly string[];
  params?: Partial<FlyEngineParams>;
  /** Stimulus encoder; defaults to the FT-7 50-channel hash nose. */
  nose?: FlyNose;
}

/**
 * Stateful only in its KC→MBON weight deltas and runtime parameters. Every
 * evaluation's stimulus/projection arrays are freshly allocated, so messages
 * never leak a repetition/session state into the next verdict.
 */
export class FlyEngine {
  readonly subgraph: FlyLearningSubgraph;
  readonly typeNames: readonly string[];
  private readonly learnedDeltas: Float32Array;
  /**
   * FT-16 connectome-backed FlyHash projection, built once per engine from
   * the immutable subgraph: channel→glomerular-PN-cohort assignment plus the
   * degree-normalized PN→KC edge CSR (both mass modes precomputed).
   */
  private readonly channelPnOffsets: Uint32Array;
  private readonly channelPnIndexes: Uint32Array;
  private readonly pnToKcOffsets: Uint32Array;
  private readonly pnToKcTargetKc: Uint32Array;
  private readonly pnToKcMassLog: Float32Array;
  private readonly kcBinaryMass: Float32Array;
  private readonly kcLogMass: Float32Array;
  /** FT-17 scratch: per-edge boost of active KC→MBON edges for the unit-reference burst. */
  private readonly unitBoostScratch: Float32Array;
  /** Swappable stimulus encoder (FT-18R); the default is the FT-7 hash nose. */
  private readonly nose: FlyNose;
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
    this.nose = options.nose ?? createHashNose();
    const projection = this.buildProjection();
    this.channelPnOffsets = projection.channelPnOffsets;
    this.channelPnIndexes = projection.channelPnIndexes;
    this.pnToKcOffsets = projection.pnToKcOffsets;
    this.pnToKcTargetKc = projection.pnToKcTargetKc;
    this.pnToKcMassLog = projection.pnToKcMassLog;
    this.kcBinaryMass = projection.kcBinaryMass;
    this.kcLogMass = projection.kcLogMass;
    this.unitBoostScratch = new Float32Array(subgraph.edgeCount);
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
    return this.nose.encode(text);
  }

  evaluate(text: string): FlyEvaluation {
    const stimulus = this.encode(text);
    if (stimulus.channels.length !== this.nose.channelCount) {
      throw new Error(
        `Fly nose emitted ${stimulus.channels.length} channels; expected ${this.nose.channelCount}.`,
      );
    }
    const activeKcIndexes = this.selectWtaKcs(stimulus.channels);
    const activeKcGlobalIndexes = activeKcIndexes.map((index) => this.subgraph.subgraphToGlobal[index]!);
    const [confidence, mbonReadout, gfSpikeCount] = this.evaluateLearnedState(activeKcIndexes);
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
      gfSpikeCount,
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

  /**
   * Build the FT-16 projection from the immutable subgraph:
   * - glomerular cohorts = distinct OLF_PN types, enumerated by ascending
   *   typeIndex (the FT-1 type table is sorted, so this is rebuild-stable);
   * - every channel owns one cohort, spread evenly across the cohort list;
   * - PN→KC edges become a per-PN CSR with both mass modes precomputed, plus
   *   per-KC total input mass for degree normalization.
   */
  private buildProjection(): {
    channelPnOffsets: Uint32Array;
    channelPnIndexes: Uint32Array;
    pnToKcOffsets: Uint32Array;
    pnToKcTargetKc: Uint32Array;
    pnToKcMassLog: Float32Array;
    kcBinaryMass: Float32Array;
    kcLogMass: Float32Array;
  } {
    const subgraph = this.subgraph;
    const distinctTypes: number[] = [];
    const seenTypes = new Set<number>();
    for (let index = 0; index < subgraph.neuronCount; index += 1) {
      if (subgraph.group[index] !== FLY_GROUP.OLF_PN) continue;
      const type = subgraph.typeIndex[index]!;
      if (!seenTypes.has(type)) {
        seenTypes.add(type);
        distinctTypes.push(type);
      }
    }
    distinctTypes.sort((a, b) => a - b);
    const cohortCount = Math.max(1, distinctTypes.length);
    const cohortByType = new Map(distinctTypes.map((type, cohort) => [type, cohort]));
    const pnsByCohort: number[][] = Array.from({ length: cohortCount }, () => []);
    for (let index = 0; index < subgraph.neuronCount; index += 1) {
      if (subgraph.group[index] !== FLY_GROUP.OLF_PN) continue;
      pnsByCohort[cohortByType.get(subgraph.typeIndex[index]!)!]!.push(index);
    }

    const channelCount = this.nose.channelCount;
    const channelPnIndexes: number[] = [];
    const channelPnOffsets = new Uint32Array(channelCount + 1);
    for (let channel = 0; channel < channelCount; channel += 1) {
      const cohort = Math.floor((channel * cohortCount) / channelCount);
      channelPnOffsets[channel] = channelPnIndexes.length;
      for (const pn of pnsByCohort[cohort]!) channelPnIndexes.push(pn);
    }
    channelPnOffsets[channelCount] = channelPnIndexes.length;

    const pnPre: number[] = [];
    const kcPost: number[] = [];
    const massLog: number[] = [];
    const kcBinaryMass = new Float32Array(subgraph.neuronCount);
    const kcLogMass = new Float32Array(subgraph.neuronCount);
    for (let edgeIndex = 0; edgeIndex < subgraph.edgeCount; edgeIndex += 1) {
      const pre = subgraph.edgePre[edgeIndex]!;
      const post = subgraph.edgePost[edgeIndex]!;
      if (subgraph.group[pre] !== FLY_GROUP.OLF_PN || subgraph.group[post] !== FLY_GROUP.KC) continue;
      pnPre.push(pre);
      kcPost.push(post);
      const log = Math.log1p(Math.abs(subgraph.baseEdgeWeight[edgeIndex]!));
      massLog.push(log);
      kcBinaryMass[post] += 1;
      kcLogMass[post] += log;
    }

    const pnToKcOffsets = new Uint32Array(subgraph.neuronCount + 1);
    for (const pre of pnPre) pnToKcOffsets[pre + 1] += 1;
    for (let index = 1; index < pnToKcOffsets.length; index += 1) {
      pnToKcOffsets[index] += pnToKcOffsets[index - 1]!;
    }
    const pnToKcTargetKc = new Uint32Array(pnPre.length);
    const pnToKcMassLog = new Float32Array(pnPre.length);
    const cursors = pnToKcOffsets.slice(0, subgraph.neuronCount);
    for (let edge = 0; edge < pnPre.length; edge += 1) {
      const pre = pnPre[edge]!;
      const cursor = cursors[pre]!;
      pnToKcTargetKc[cursor] = kcPost[edge]!;
      pnToKcMassLog[cursor] = massLog[edge]!;
      cursors[pre] = cursor + 1;
    }

    return {
      channelPnOffsets,
      channelPnIndexes: Uint32Array.from(channelPnIndexes),
      pnToKcOffsets,
      pnToKcTargetKc,
      pnToKcMassLog,
      kcBinaryMass,
      kcLogMass,
    };
  }

  /**
   * FT-16 winner-take-all KC code: project active channel cohorts through the
   * real PN→KC edges, degree-normalize each KC by its total PN input mass, and
   * keep the strongest `kcSparsity` fraction (ties broken by subgraph index).
   * Only positively-driven KCs enter the code; a stimulus reaching fewer KCs
   * than the quota simply yields a shorter code.
   */
  private selectWtaKcs(channels: Float32Array): number[] {
    const logMode = this.params.projectionMode === "log-synapse";
    const scores = new Float32Array(this.subgraph.neuronCount);
    for (let channel = 0; channel < channels.length; channel += 1) {
      const activation = channels[channel]!;
      if (activation <= 0) continue;
      const pnStart = this.channelPnOffsets[channel]!;
      const pnEnd = this.channelPnOffsets[channel + 1]!;
      for (let pnCursor = pnStart; pnCursor < pnEnd; pnCursor += 1) {
        const pn = this.channelPnIndexes[pnCursor]!;
        const edgeStart = this.pnToKcOffsets[pn]!;
        const edgeEnd = this.pnToKcOffsets[pn + 1]!;
        for (let edgeCursor = edgeStart; edgeCursor < edgeEnd; edgeCursor += 1) {
          const mass = logMode ? this.pnToKcMassLog[edgeCursor]! : 1;
          scores[this.pnToKcTargetKc[edgeCursor]!] += activation * mass;
        }
      }
    }
    const candidates: Array<{ index: number; score: number }> = [];
    for (const kc of this.subgraph.kcIndexes) {
      const total = logMode ? this.kcLogMass[kc]! : this.kcBinaryMass[kc]!;
      if (total <= 0) continue;
      const score = scores[kc]! / total;
      if (score > 0) candidates.push({ index: kc, score });
    }
    candidates.sort((a, b) => b.score - a.score || a.index - b.index);
    const wanted = Math.max(1, Math.ceil(this.subgraph.kcIndexes.length * this.params.kcSparsity));
    return candidates.slice(0, wanted).map((candidate) => candidate.index);
  }

  /**
   * FT-17 downstream trial. The WTA code seeds one tick-zero LIF burst per
   * weight state: the fresh baseline (`null` deltas), the current learned
   * state, and a unit reference boosting every active KC→MBON synapse by one
   * full-confidence event. Confidence is the learned MBON-response change as
   * a fraction of the unit-reference change — a fresh fly is exactly 0 (both
   * bursts identical) and PAM evidence pulls the change toward or below 0.
   * A nonpositive unit change (earlier spikes can shorten accumulation)
   * safely yields confidence 0 instead of dividing by a degenerate scale.
   */
  private evaluateLearnedState(
    activeKcIndexes: readonly number[],
  ): [confidence: number, mbonReadout: FlyMbonReadout[], gfSpikeCount: number] {
    const base = this.runDownstreamBurst(activeKcIndexes, null);
    const learned = this.runDownstreamBurst(activeKcIndexes, this.learnedDeltas);
    const active = new Uint8Array(this.subgraph.neuronCount);
    for (const index of activeKcIndexes) active[index] = 1;
    this.unitBoostScratch.fill(0);
    for (const edgeIndex of this.subgraph.kcToMbonEdgeIndexes) {
      if (active[this.subgraph.edgePre[edgeIndex]!] === 1) {
        this.unitBoostScratch[edgeIndex] = this.params.learnedDeltaForFullConfidence;
      }
    }
    const unit = this.runDownstreamBurst(activeKcIndexes, this.unitBoostScratch);
    const unitChange = unit.response - base.response;
    const confidence = unitChange > 0 ? clamp((learned.response - base.response) / unitChange, 0, 1) : 0;
    return [confidence, this.readMbonReadout(learned), learned.gfSpikes];
  }

  /**
   * Bounded LIF burst seeded by the WTA code (FT-17): the selected KCs spike
   * at tick zero, then `burstTicks` ticks of leaky integration run over the
   * real downstream edges of every spiking neuron — KC→MBON, MBON→DAN,
   * DAN→KC, MBON→MBON, and GF wherever the learning subgraph actually has
   * them (on MCNS all GF inputs come from the dropped OTHER group, so GF
   * stays structurally silent). Refractory neurons neither integrate nor
   * spike. The readout accumulates each MBON's positive potential per tick,
   * so a response exists even when nothing crosses the spiking threshold.
   */
  private runDownstreamBurst(seedKcIndexes: readonly number[], deltaOverride: Float32Array | null): FlyBurstResult {
    const subgraph = this.subgraph;
    const { leak, threshold, refractoryTicks, weightScale, burstTicks } = this.params;
    const potentials = new Float32Array(subgraph.neuronCount);
    const refractoryUntil = new Int32Array(subgraph.neuronCount).fill(-1);
    const seen = new Uint8Array(subgraph.neuronCount);
    const mbonIntegrated = new Float32Array(subgraph.neuronCount);
    const mbonSpikes = new Uint16Array(subgraph.neuronCount);
    let gfSpikes = 0;
    let frontier: number[] = [];
    for (const kc of seedKcIndexes) {
      refractoryUntil[kc] = refractoryTicks;
      frontier.push(kc);
    }
    const touched: number[] = [];
    const next: number[] = [];
    for (let tick = 1; tick <= burstTicks; tick += 1) {
      for (let index = 0; index < potentials.length; index += 1) potentials[index]! *= leak;
      touched.length = 0;
      seen.fill(0);
      for (const pre of frontier) {
        const start = subgraph.outgoingOffsets[pre]!;
        const end = subgraph.outgoingOffsets[pre + 1]!;
        for (let cursor = start; cursor < end; cursor += 1) {
          const edgeIndex = subgraph.outgoingEdgeIndexes[cursor]!;
          const post = subgraph.edgePost[edgeIndex]!;
          if (refractoryUntil[post]! >= tick) continue;
          potentials[post] += weightScale * this.burstEdgeWeight(edgeIndex, deltaOverride);
          if (seen[post] === 0) {
            seen[post] = 1;
            touched.push(post);
          }
        }
      }
      next.length = 0;
      for (const post of touched) {
        const potential = potentials[post]!;
        const group = subgraph.group[post]!;
        if (group === FLY_GROUP.MBON) mbonIntegrated[post] += Math.max(0, potential);
        if (potential >= threshold) {
          potentials[post] = 0;
          refractoryUntil[post] = tick + refractoryTicks;
          if (group === FLY_GROUP.MBON) mbonSpikes[post] += 1;
          else if (group === FLY_GROUP.GF) gfSpikes += 1;
          next.push(post);
        }
      }
      frontier = next.slice();
    }
    let response = 0;
    for (const mbon of subgraph.mbonIndexes) response += mbonIntegrated[mbon]!;
    return { mbonIntegrated, mbonSpikes, response, gfSpikes };
  }

  private burstEdgeWeight(edgeIndex: number, deltaOverride: Float32Array | null): number {
    const delta = deltaOverride === null ? 0 : deltaOverride[edgeIndex]!;
    return (this.subgraph.baseEdgeWeight[edgeIndex]! + delta) / this.subgraph.synapseNormalization;
  }

  private readMbonReadout(burst: FlyBurstResult): FlyMbonReadout[] {
    return Array.from(this.subgraph.mbonIndexes, (index) => ({
      subgraphIndex: index,
      globalIndex: this.subgraph.subgraphToGlobal[index]!,
      typeName: this.typeNames[this.subgraph.typeIndex[index]!] ?? null,
      activation: burst.mbonIntegrated[index]!,
      spikes: burst.mbonSpikes[index]!,
    })).filter((entry) => entry.activation > 0 || entry.spikes > 0);
  }

  private assertParams(params: FlyEngineParams): void {
    if (!Number.isFinite(params.leak) || params.leak < 0 || params.leak > 1) throw new Error("Fly LIF leak must be between 0 and 1.");
    if (!Number.isFinite(params.threshold) || params.threshold <= 0) throw new Error("Fly LIF threshold must be positive.");
    if (!Number.isInteger(params.refractoryTicks) || params.refractoryTicks < 0 || params.refractoryTicks > 255) throw new Error("Fly LIF refractory ticks must be an integer from 0 to 255.");
    if (!Number.isFinite(params.weightScale) || params.weightScale <= 0) throw new Error("Fly LIF weight scale must be positive.");
    if (!Number.isFinite(params.tickRateHz) || params.tickRateHz <= 0) throw new Error("Fly LIF tick rate must be positive.");
    if (!Number.isInteger(params.burstTicks) || params.burstTicks < 1 || params.burstTicks > 100) throw new Error("Fly LIF burst ticks must be an integer from 1 to 100.");
    if (!Number.isFinite(params.kcSparsity) || params.kcSparsity <= 0 || params.kcSparsity > 1) throw new Error("Fly KC sparsity must be in (0, 1].");
    if (!Number.isInteger(params.maxDrivingSpans) || params.maxDrivingSpans < 1) throw new Error("Fly driving-span limit must be a positive integer.");
    if (!Number.isFinite(params.learnedDeltaForFullConfidence) || params.learnedDeltaForFullConfidence <= 0) throw new Error("Fly learned-delta normalization must be positive.");
    if (!(FLY_PROJECTION_MODES as readonly string[]).includes(params.projectionMode)) {
      throw new Error("Fly projection mode must be 'binary' or 'log-synapse'.");
    }
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
