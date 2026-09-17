/**
 * @module imagegen/backends/comfyui
 *
 * ComfyUI local backend adapter (COMFYUI_BACKEND_PLAN CG-A1) — the raw
 * HTTP API surface (`/prompt`, `/history`, `/view`), NOT the node-canvas
 * UX. One adapter covers ComfyUI proper (any launcher: Stability Matrix,
 * portable, git, comfy-cli — vanilla ComfyUI core has no auth and no
 * model-downloader state we depend on) because the wire surface is
 * version-stable across them.
 *
 * FLAT-FORM MAPPING (the plan's non-negotiable): the workflow JSON is an
 * implementation detail the adapter maps VT's flat generation fields onto.
 * v1 carries the CHECKPOINT template only (`CheckpointLoaderSimple →
 * CLIPTextEncode×2 → KSampler → VAEDecode → SaveImage`, plus
 * `CLIPSetLastLayer` when clipSkip is set); the Krea-2 DiT template and
 * the live sampler/model unions land in CG-A2/A3.
 *
 * Doc gate (every wire fact below live-verified on the owner's ComfyUI
 * 0.36.0 / Stability Matrix instance, 2026-09-18 — probe scripts in
 * reports/IMAGEGEN_POLISH_REPORT.md § PG-5):
 * - generation: `POST /prompt` with `{prompt: <workflow graph>, client_id}`
 *   → `{prompt_id, number, node_errors}`. A NON-EMPTY `node_errors` object
 *   means the graph was rejected (bad ckpt_name etc.) — surfaced as a
 *   caller-class error (status 400 on the adapter error): the request
 *   content is wrong, not the gateway.
 * - completion: `GET /history/{prompt_id}` — the response is a map keyed
 *   by prompt id; an absent key = still queued/running. Terminal success:
 *   `status.completed === true` with `outputs[nodeId].images[]` entries
 *   `{filename, subfolder, type}`. Terminal failure: `status.status_str
 *   === "error"` with the readable reason inside `status.messages[]` as
 *   the `execution_error` pair's `exception_message`.
 * - download: `GET /view?filename=&subfolder=&type=output` → raw image
 *   bytes (SaveImage emits PNG; MIME sniffs as a fallback).
 * - model list: `GET /models/checkpoints` → the recursive filename list
 *   (subfolder entries ride the server's own separator, verbatim — the
 *   round-trip back into `ckpt_name` must be byte-identical).
 * - probe: `GET /system_stats` → `{system: {comfyui_version, ...},
 *   devices: [...]}` — the cheapest always-present liveness endpoint.
 * - auth: NONE in core — a non-empty apiKey is a configuration mistake
 *   (a proxy-fronted instance is out of v1 scope) and fails closed with
 *   a clear message instead of inventing a header ComfyUI would ignore.
 *
 * Card-driven deviations from the a1111 twin (named, verified):
 * - NO sync generation POST: ComfyUI queues asynchronously, so the adapter
 *   polls `/history` until terminal. The poll cadence is a named internal
 *   constant (NOT a user-facing generation parameter — the owner's ban
 *   covers generation params; completion detection is transport mechanics,
 *   same class as the cloud timeout budget).
 * - NO server-side parameter defaults: a workflow graph must carry values
 *   for every required KSampler/EmptyLatent input, so an unset field
 *   materializes the NODE-CLASS DEFAULT exactly as the server's own
 *   /object_info declares it (steps 20, cfg 8, sampler "euler", scheduler
 *   "normal", latent 512×512, denoise 1 — live-verified constants, the
 *   comfy equivalent of a1111's "omit and the server fills").
 * - seed -1 / unset resolves IN THE ADAPTER (client-side random ≤
 *   MAX_SAFE_INTEGER): ComfyUI has no -1 sentinel. The resolved value is
 *   reported back as `result.seed` — we authored it, so it is exact.
 * - NO keyless-model path: the graph must name its checkpoint
 *   (`CheckpointLoaderSimple.ckpt_name`); with neither request model nor
 *   profile model the adapter fails closed (a1111's "server's loaded
 *   checkpoint" has no ComfyUI equivalent — there is no loaded-model
 *   state).
 * - NO local timeout: the run continues until terminal state or the
 *   caller's abort (the localExecution contract; the poll delay is
 *   abortable so cancellation is prompt).
 * - clipSkip rides `CLIPSetLastLayer.stop_at_clip_layer = -clipSkip`
 *   (ComfyUI counts from the end; the node is OMITTED when clipSkip is
 *   unset — no silent layer-slicing).
 * - v1 ignores (no VT field maps yet): denoise stays the node default 1
 *   (txt2img), batch_size 1, `preview_method` and the WS progress surface
 *   (CG-C1).
 */

import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import type {
  ImageGenAdapterConfig,
  ImageGenBackend,
  ImageGenGeneratedImage,
  ImageGenGenerateRequest,
  ImageGenGenerateResult,
  ImageGenModelInfo,
  ImageGenProbeResult,
} from "../imagegen-backend.js";
import { registerImageGenBackend } from "../imagegen-registry.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

/** HTTP / transport / execution failure of a generation or listing request. */
export class ComfyImageGenError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures and graph rejections). */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "ComfyImageGenError";
    this.status = options?.status;
  }
}

/** Profile config problem (missing endpoint, or a key on a keyless backend). */
export class ComfyImageGenConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComfyImageGenConfigError";
  }
}

/** A width/height that is not a positive integer — the free-size fail
 *  closed error (the a1111 twin). */
export class ComfyImageGenSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComfyImageGenSizeError";
  }
}

// ─── Workflow template (checkpoint, CG-A1) ───────────────────────────────────

/** Stable node ids — part of the template contract the tests pin (the
 *  /history outputs are keyed by the SaveImage node id). */
export const COMFY_NODE_IDS = {
  kSampler: "3",
  checkpoint: "4",
  latent: "5",
  positive: "6",
  negative: "7",
  vaeDecode: "8",
  saveImage: "9",
  clipSetLastLayer: "10",
} as const;

/** The workflow graph the flat request maps onto: a record of node id →
 *  `{class_type, inputs}` — the exact `prompt` value POSTed to `/prompt`. */
export type ComfyWorkflowGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** Node-class defaults for the graph inputs VT leaves unset — verbatim
 *  from the live /object_info KSampler/EmptyLatentImage declarations
 *  (0.36.0, research-pinned). These are the SERVER's own defaults
 *  materialized client-side because a workflow graph cannot omit a
 *  required input — the comfy equivalent of a1111's omit-and-server-fills. */
export const COMFY_NODE_DEFAULTS = {
  steps: 20,
  cfg: 8,
  samplerName: "euler",
  scheduler: "normal",
  latentWidth: 512,
  latentHeight: 512,
  denoise: 1,
  batchSize: 1,
  filenamePrefix: "vt_imagegen",
} as const;

/** The SaveImage node's output-rows container (top-level node outputs ride
 *  the history entry keyed by node id). */
interface ComfyHistoryOutputImage {
  filename: string;
  subfolder?: string;
  type?: string;
}

/** Validate a free W×H integer (positive, finite, integral). */
function requirePositiveInt(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new ComfyImageGenSizeError(
      `ComfyUI image generation accepts a positive integer ${name} — got ${value}`,
    );
  }
  return value;
}

/** A set string field: trimmed and non-empty, else undefined. */
function setOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Resolve the graph seed: unset or the -1 "random" sentinel becomes a
 *  client-side random (ComfyUI has no server sentinel; the resolved value
 *  is returned so the caller can report it as the exact used seed). */
function resolveComfySeed(seed: number | undefined): number {
  if (seed !== undefined && seed !== -1) return seed;
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

/** Build the CHECKPOINT-template workflow graph from the flat request +
 *  the resolved profile model. Pure — exported for the wire tests. The
 *  second return value is the seed actually placed in the graph. */
export function buildComfyCheckpointWorkflow(
  request: ImageGenGenerateRequest,
  resolvedModel: string,
): { graph: ComfyWorkflowGraph; seed: number } {
  const seed = resolveComfySeed(request.seed);
  const width = request.width !== undefined ? requirePositiveInt("width", request.width) : undefined;
  const height = request.height !== undefined ? requirePositiveInt("height", request.height) : undefined;
  const clipSkip = request.clipSkip;

  // The clip source of the two text encoders: the loader output directly,
  // or through CLIPSetLastLayer when the request slices layers.
  const clipSource: [string, number] = clipSkip !== undefined ? [COMFY_NODE_IDS.clipSetLastLayer, 0] : [COMFY_NODE_IDS.checkpoint, 1];

  const graph: ComfyWorkflowGraph = {
    [COMFY_NODE_IDS.kSampler]: {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: request.steps ?? COMFY_NODE_DEFAULTS.steps,
        cfg: request.cfgScale ?? COMFY_NODE_DEFAULTS.cfg,
        sampler_name: setOrUndefined(request.sampler) ?? COMFY_NODE_DEFAULTS.samplerName,
        scheduler: setOrUndefined(request.scheduler) ?? COMFY_NODE_DEFAULTS.scheduler,
        denoise: COMFY_NODE_DEFAULTS.denoise,
        model: [COMFY_NODE_IDS.checkpoint, 0],
        positive: [COMFY_NODE_IDS.positive, 0],
        negative: [COMFY_NODE_IDS.negative, 0],
        latent_image: [COMFY_NODE_IDS.latent, 0],
      },
    },
    [COMFY_NODE_IDS.checkpoint]: {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: resolvedModel },
    },
    [COMFY_NODE_IDS.latent]: {
      class_type: "EmptyLatentImage",
      inputs: {
        width: width ?? COMFY_NODE_DEFAULTS.latentWidth,
        height: height ?? COMFY_NODE_DEFAULTS.latentHeight,
        batch_size: COMFY_NODE_DEFAULTS.batchSize,
      },
    },
    [COMFY_NODE_IDS.positive]: {
      class_type: "CLIPTextEncode",
      inputs: { text: request.prompt, clip: clipSource },
    },
    [COMFY_NODE_IDS.negative]: {
      class_type: "CLIPTextEncode",
      inputs: { text: request.negativePrompt ?? "", clip: clipSource },
    },
    [COMFY_NODE_IDS.vaeDecode]: {
      class_type: "VAEDecode",
      inputs: { samples: [COMFY_NODE_IDS.kSampler, 0], vae: [COMFY_NODE_IDS.checkpoint, 2] },
    },
    [COMFY_NODE_IDS.saveImage]: {
      class_type: "SaveImage",
      inputs: { filename_prefix: COMFY_NODE_DEFAULTS.filenamePrefix, images: [COMFY_NODE_IDS.vaeDecode, 0] },
    },
  };
  if (clipSkip !== undefined) {
    graph[COMFY_NODE_IDS.clipSetLastLayer] = {
      class_type: "CLIPSetLastLayer",
      // ComfyUI counts from the end: clipSkip 2 (skip one layer) → -2;
      // clipSkip 1 → -1 = the node's own no-skip default.
      inputs: { stop_at_clip_layer: -clipSkip, clip: [COMFY_NODE_IDS.checkpoint, 1] },
    };
  }
  return { graph, seed };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalize a pasted base URL: trailing slashes and a pasted `…/prompt`
 *  generation path are tolerated (the paste-tolerance discipline). */
function normalizeComfyBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/prompt")) {
    normalized = normalized.slice(0, -"/prompt".length);
  }
  return normalized.replace(/\/+$/, "");
}

/** Sniff the MIME type from image bytes by format signature (png / jpeg /
 *  webp) — /view serves without a reliable Content-Type; PNG is the
 *  SaveImage default and the fallback. */
function sniffImageMime(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** Await a fetch call through the injected seam. Transport-level failures
 *  wrap into the adapter's typed error — EXCEPT the caller's own abort,
 *  which is rethrown untouched (the abort contract of the a1111 twin). */
async function fetchOrWrap(
  transport: typeof fetch,
  url: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  try {
    return await transport(url, init);
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw new ComfyImageGenError(
      `ComfyUI image-gen ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/** The completion-poll cadence — transport mechanics, not a generation
 *  parameter (see the module doc gate). */
export const COMFY_HISTORY_POLL_INTERVAL_MS = 250;

/** An abort-aware delay between history polls: the caller's cancel exits
 *  the wait promptly with the raw AbortError (user cancel, not a failure). */
function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort);
  });
}

/** One `/history/{id}` poll response classified: pending (keep polling),
 *  done (the SaveImage output rows), or failed (the execution_error
 *  message). */
type ComfyPollOutcome =
  | { kind: "pending" }
  | { kind: "done"; images: ComfyHistoryOutputImage[] }
  | { kind: "failed"; message: string };

/** Extract the readable failure reason from a terminal error entry: the
 *  `status.messages` array of `[type, payload]` pairs carries the
 *  `execution_error` payload with `exception_message` (+ node_type /
 *  node_id for locating it). Anything unreadable degrades to the status
 *  string, never an invented message. */
function classifyHistoryEntry(entry: unknown): ComfyPollOutcome {
  if (typeof entry !== "object" || entry === null) return { kind: "pending" };
  const record = entry as Record<string, unknown>;
  const status = record.status;
  if (typeof status !== "object" || status === null) return { kind: "pending" };
  const statusRecord = status as Record<string, unknown>;
  if (statusRecord.status_str === "error") {
    let message = "ComfyUI execution error";
    const messages = statusRecord.messages;
    if (Array.isArray(messages)) {
      for (const pair of messages) {
        if (!Array.isArray(pair) || pair[0] !== "execution_error") continue;
        const payload = pair[1];
        if (typeof payload !== "object" || payload === null) continue;
        const detail = payload as Record<string, unknown>;
        const parts: string[] = [];
        if (typeof detail.node_type === "string" && detail.node_type.length > 0) parts.push(detail.node_type);
        if (typeof detail.exception_message === "string" && detail.exception_message.length > 0) {
          parts.push(detail.exception_message);
        }
        if (parts.length > 0) {
          message = `ComfyUI execution error: ${parts.join(": ")}`;
          break;
        }
      }
    }
    return { kind: "failed", message };
  }
  if (statusRecord.completed !== true) return { kind: "pending" };
  const outputs = record.outputs;
  if (typeof outputs !== "object" || outputs === null) {
    return { kind: "failed", message: "ComfyUI completed the prompt but the history entry carries no outputs" };
  }
  const nodeOutput = (outputs as Record<string, unknown>)[COMFY_NODE_IDS.saveImage];
  if (typeof nodeOutput !== "object" || nodeOutput === null) {
    return { kind: "failed", message: "ComfyUI completed the prompt but the SaveImage node produced no output" };
  }
  const images = (nodeOutput as Record<string, unknown>).images;
  if (!Array.isArray(images) || images.length === 0) {
    return { kind: "failed", message: "ComfyUI completed the prompt with no saved images" };
  }
  const rows: ComfyHistoryOutputImage[] = [];
  for (const image of images) {
    if (typeof image !== "object" || image === null) continue;
    const row = image as Record<string, unknown>;
    if (typeof row.filename !== "string" || row.filename.length === 0) continue;
    rows.push({
      filename: row.filename,
      ...(typeof row.subfolder === "string" && row.subfolder.length > 0 ? { subfolder: row.subfolder } : {}),
      ...(typeof row.type === "string" && row.type.length > 0 ? { type: row.type } : {}),
    });
  }
  if (rows.length === 0) {
    return { kind: "failed", message: "ComfyUI completed the prompt but the saved-image rows are malformed" };
  }
  return { kind: "done", images: rows };
}

/** Await prompt completion by polling `/history/{id}` until terminal —
 *  abortable, no timeout (the localExecution contract). */
async function waitForPromptCompletion(
  transport: typeof fetch,
  endpoint: string,
  promptId: string,
  signal: AbortSignal | undefined,
): Promise<ComfyHistoryOutputImage[]> {
  for (;;) {
    const response = await fetchOrWrap(
      transport,
      `${endpoint}/history/${encodeURIComponent(promptId)}`,
      { method: "GET", headers: { Accept: "application/json" }, signal },
      "history poll",
    );
    if (!response.ok) {
      const excerpt = await readProviderErrorBody(response);
      throw new ComfyImageGenError(
        `ComfyUI history poll failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
        { status: response.status },
      );
    }
    const parsed: unknown = await response.json().catch(() => null);
    const entry = typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)[promptId]
      : undefined;
    const outcome = classifyHistoryEntry(entry);
    if (outcome.kind === "done") return outcome.images;
    if (outcome.kind === "failed") throw new ComfyImageGenError(outcome.message);
    await abortableDelay(COMFY_HISTORY_POLL_INTERVAL_MS, signal);
  }
}

/** Parse the `GET /models/checkpoints` filename list into picker entries:
 *  `id` keeps the server's path VERBATIM (it round-trips into
 *  `ckpt_name` byte-identically); `label` shows the basename without the
 *  weights extension. Non-string entries are skipped. */
function parseCheckpointFilenames(parsed: unknown): ImageGenModelInfo[] {
  if (!Array.isArray(parsed)) return [];
  const out: ImageGenModelInfo[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    const base = entry.split(/[\\/]/).pop() ?? entry;
    const label = base.replace(/\.(safetensors|ckpt|pt|pth|gguf|bin)$/i, "");
    out.push({ id: entry, label: label.length > 0 ? label : entry });
  }
  return out;
}

// ─── Config ──────────────────────────────────────────────────────────────────

interface ComfyImageGenConfig {
  endpoint: string;
  model: string | undefined;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): ComfyImageGenConfig {
  const endpoint = normalizeComfyBaseUrl(config.endpoint ?? "");
  if (!endpoint) {
    throw new ComfyImageGenConfigError(
      "ComfyUI image-gen config error: `endpoint` is required (the local server's base URL, e.g. http://127.0.0.1:8188)",
    );
  }
  if (config.apiKey !== undefined && config.apiKey.trim() !== "") {
    throw new ComfyImageGenConfigError(
      "ComfyUI image-gen config error: ComfyUI core has no authentication — clear the API key field",
    );
  }
  return {
    endpoint,
    model: setOrUndefined(config.model),
    fetch: config.fetch ?? fetch,
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export const comfyImageGenFactory = (config: ImageGenAdapterConfig): ImageGenBackend => {
  const cfg = parseConfig(config);

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const model = setOrUndefined(request.model) ?? cfg.model;
      if (model === undefined) {
        throw new ComfyImageGenConfigError(
          "ComfyUI image generation requires a selected checkpoint (the workflow graph names its model)",
        );
      }
      const { graph, seed } = buildComfyCheckpointWorkflow(request, model);

      const clientId = crypto.randomUUID();
      const queuedResponse = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/prompt`,
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: graph, client_id: clientId }),
          signal: request.signal,
        },
        "generation queue",
      );
      if (!queuedResponse.ok) {
        const excerpt = await readProviderErrorBody(queuedResponse);
        throw new ComfyImageGenError(
          `ComfyUI prompt queue failed with HTTP ${queuedResponse.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: queuedResponse.status },
        );
      }
      const queued: unknown = await queuedResponse.json().catch(() => null);
      const queuedRecord = typeof queued === "object" && queued !== null ? queued as Record<string, unknown> : {};
      const promptId = queuedRecord.prompt_id;
      if (typeof promptId !== "string" || promptId.length === 0) {
        throw new ComfyImageGenError("ComfyUI prompt queue response carried no prompt_id");
      }
      // A non-empty node_errors = the server rejected the graph (unknown
      // checkpoint name, wrong input types) — caller-class, mapped to the
      // 400 rung of the route ladder.
      const nodeErrors = queuedRecord.node_errors;
      if (typeof nodeErrors === "object" && nodeErrors !== null && Object.keys(nodeErrors).length > 0) {
        const details: string[] = [];
        for (const [nodeId, error] of Object.entries(nodeErrors as Record<string, unknown>)) {
          if (typeof error === "object" && error !== null) {
            const detail = error as Record<string, unknown>;
            const message = typeof detail.errors === "object" && Array.isArray(detail.errors)
              ? detail.errors.length
              : undefined;
            details.push(`node ${nodeId}${message !== undefined ? ` (${message} errors)` : ""}`);
          } else {
            details.push(`node ${nodeId}`);
          }
        }
        throw new ComfyImageGenError(
          `ComfyUI rejected the workflow graph${details.length > 0 ? `: ${details.join(", ")}` : ""}`,
          { status: 400 },
        );
      }

      const outputImages = await waitForPromptCompletion(cfg.fetch, cfg.endpoint, promptId, request.signal);

      const images: ImageGenGeneratedImage[] = [];
      for (const row of outputImages) {
        const viewUrl =
          `${cfg.endpoint}/view?filename=${encodeURIComponent(row.filename)}` +
          `&subfolder=${encodeURIComponent(row.subfolder ?? "")}` +
          `&type=${encodeURIComponent(row.type ?? "output")}`;
        const viewResponse = await fetchOrWrap(
          cfg.fetch,
          viewUrl,
          { method: "GET", headers: { Accept: "image/*" }, signal: request.signal },
          "image download",
        );
        if (!viewResponse.ok) {
          const excerpt = await readProviderErrorBody(viewResponse);
          throw new ComfyImageGenError(
            `ComfyUI image download failed with HTTP ${viewResponse.status}${excerpt ? `: ${excerpt}` : ""}`,
            { status: viewResponse.status },
          );
        }
        const data = Buffer.from(await viewResponse.arrayBuffer());
        if (data.length === 0) {
          throw new ComfyImageGenError("ComfyUI image download returned zero bytes");
        }
        images.push({ data, mimeType: sniffImageMime(data) ?? "image/png" });
      }

      // Wire meaning of what was sent (the a1111 twin): W/H echo
      // independently; the seed is the graph's own resolved value.
      const result: ImageGenGenerateResult = { images, seed };
      if (request.width !== undefined) result.width = request.width;
      if (request.height !== undefined) result.height = request.height;
      return result;
    },

    async listModels(signal?: AbortSignal): Promise<ImageGenModelInfo[]> {
      const response = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/models/checkpoints`,
        { method: "GET", headers: { Accept: "application/json" }, signal },
        "model list",
      );
      if (!response.ok) {
        const excerpt = await readProviderErrorBody(response);
        throw new ComfyImageGenError(
          `ComfyUI model list failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
      const parsed: unknown = await response.json().catch(() => null);
      return parseCheckpointFilenames(parsed);
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      try {
        const response = await cfg.fetch(`${cfg.endpoint}/system_stats`, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal,
        });
        if (!response.ok) {
          const excerpt = await readProviderErrorBody(response);
          return {
            ok: false,
            detail: `${response.status}${excerpt ? `: ${excerpt}` : ""}`,
            status: response.status,
          };
        }
        const parsed: unknown = await response.json().catch(() => null);
        let detail = "ComfyUI server";
        const system = typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>).system
          : undefined;
        if (typeof system === "object" && system !== null) {
          const version = (system as Record<string, unknown>).comfyui_version;
          if (typeof version === "string" && version.length > 0) detail = `ComfyUI ${version}`;
        }
        return { ok: true, detail };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async dispose(): Promise<void> {
      // Stateless — nothing to release. (The WS progress listener of CG-C1
      // will become the first held resource.)
    },
  };

  return backend;
};

// Module-scope registration (protocol-registry pattern, the a1111 twin):
// importing this module makes the 'comfyui' image-gen slug creatable via
// the image-gen registry.
registerImageGenBackend(IMAGE_GEN_BACKENDS.ComfyUI, comfyImageGenFactory);
