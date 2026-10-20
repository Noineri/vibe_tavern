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
 * The workflow-graph builders live in comfyui-workflows.ts, the
 * second-pass subgraphs (hires fix + face detailer) in
 * comfyui-second-passes.ts, the error classes in comfyui-errors.ts,
 * and the shared REST listing walkers in comfyui-listing.ts — all
 * re-exported below, so importing this module is unchanged (IG-R2).
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
 * - model list: `GET /models/checkpoints` + `GET /models/diffusion_models`
 *   → the UNION the picker serves (CG-A3): checkpoints first, then DiT
 *   models, each entry carrying its `template` marker. Ids keep the
 *   server's path VERBATIM (subfolder entries ride the server's own
 *   separator — the round-trip back into `ckpt_name`/`unet_name` must be
 *   byte-identical).
 * - model FAMILY (CG-A3): three metadata stores, first hit wins, every
 *   store degrading silently (a failed store never fails the list): (1)
 *   metadata EMBEDDED in the safetensors header via `GET
 *   /view_metadata/{folder}?filename=` (`ss_base_model_version` /
 *   `modelspec.architecture` — trainer truth, install-agnostic); (2)
 *   `.cm-info.json` sidecars (Stability Matrix, top-level `BaseModel`);
 *   (3) `.civitai.info` sidecars (the civitai download flow, top-level
 *   `baseModel`). Sidecar paths join against `GET
 *   /internal/folder_paths` (ComfyUI's own folder map — root lists per
 *   folder; on a remote host the paths don't exist locally and resolution
 *   auto-degrades to embedded-only). Raw values normalize through
 *   `normalizeComfyFamily` (canonical ecosystem buckets; unrecognized
 *   values pass through verbatim — the honest labeled bucket).
 *   IPT-3 reuses the SAME stores for family detection: `readModelDetectionMetadata`
 *   surfaces the RAW embedded label for one model (mapping happens
 *   detection-side — no picker bucket collapse) plus the folder-roots
 *   sidecar anchor; core ComfyUI exposes NO hash, so the Civitai by-hash
 *   source stays structurally unavailable on this dialect.
 * - sampler/scheduler lists (CG-A3): the `KSampler` node's own combo enums
 *   (`/object_info/KSampler` → `input.required.sampler_name[0]` /
 *   `scheduler[0]`) — bare strings, no aliases/labels.
 * - node input lists: `GET /object_info/{node}` → `input.required.{field}`
 *   combo values (the accepted filename enums — used for template
 *   detection). Sidecar folder lists: `GET /models/text_encoders` and
 *   `GET /models/vae` (CLIPLoader reads the text_encoders folder, NOT
 *   clip — 0.36 live-verified).
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
 * - NO keyless-model path: the graph must name its model (checkpoint or
 *   diffusion model); with neither request model nor profile model the
 *   adapter fails closed (a1111's "server's loaded checkpoint" has no
 *   ComfyUI equivalent — there is no loaded-model state). A model found in
 *   NEITHER loader folder fails closed with the model named (stale
 *   profile selection, deleted file).
 * - DiT SIDECAR RESOLUTION (CG-A2): the Krea-2 template needs a text
 *   encoder and a VAE the checkpoint template gets for free. Explicit
 *   request values ride VERBATIM (server validates); unset resolves
 *   against the live folder list — the canonical Krea-2 ecosystem file
 *   (`qwen3vl_4b_fp8_scaled.*` / `qwen_image_vae.*`, extension-flexible),
 *   else the folder's SINGLE entry when only one exists, else a config
 *   error naming the candidates (never a silent guess among many — the
 *   owner's "don't lean on my local data" rule: canonical names are the
 *   ecosystem spec, not a mirror of one install).
 * - NO local timeout: the run continues until terminal state or the
 *   caller's abort (the localExecution contract; the poll delay is
 *   abortable so cancellation is prompt).
 * - v1 ignores (no VT field maps yet): denoise stays the node default 1
 *   (txt2img), batch_size 1, `preview_method`, and the WS preview BINARY
 *   frames (live latent thumbs = the documented fast-follow; the step
 *   events themselves are mapped, CG-C1).
 *
 */

import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import type {
  ImageGenAdapterConfig,
  ImageGenBackend,
  ImageGenGeneratedImage,
  ImageGenGenerateRequest,
  ImageGenGenerateResult,
  ImageGenDitSidecars,
  ImageGenModelDetectionMetadata,
  ImageGenModelInfo,
  ImageGenProbeResult,
  ImageGenProgressInfo,
  ImageGenLoraInfo,
  ImageGenSamplerInfo,
  ImageGenSchedulerInfo,
  ImageGenWebSocketLike,
  ImageGenUpscalerInfo,
} from "../imagegen-backend.js";
import { registerImageGenBackend } from "../imagegen-registry.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";
import {
  COMFY_DIT_WORKFLOW_SHAPES,
  COMFY_TEMPLATE_SPECS,
  comfyWeightsBasename,
  resolveComfySidecar,
} from "./comfy-workflow-templates.js";
import type { ComfyDitTemplateSpec } from "./comfy-workflow-templates.js";
import {
  COMFY_MODEL_TEMPLATES,
  COMFY_NODE_IDS,
  buildComfyCheckpointWorkflow,
  buildComfyDitWorkflow,
  buildComfyKrea2Workflow,
  comfyTemplateMarker,
  isComfyManualDitTemplate,
  resolveComfyAutoDiffusionTemplate,
  resolveComfyListedDiffusionTemplate,
  resolveComfyManualWorkflowTemplate,
} from "./comfyui-workflows.js";
import type { ComfySecondPassCtx, ComfyWorkflowGraph } from "./comfyui-workflows.js";
import {
  applyComfyFaceDetailerPass,
  applyComfyHiresPass,
  comfyNodeClassExists,
  fetchComfyFaceDetectors,
} from "./comfyui-second-passes.js";
import { ComfyImageGenConfigError, ComfyImageGenError } from "./comfyui-errors.js";
import { fetchComfyComboValues, fetchComfyFolderNames, isObjectLike } from "./comfyui-listing.js";

// ─── Moved-out sections, re-exported (IG-R2) ────────────────────────────────
// Errors, workflow builders, and second passes moved to sibling modules so
// each stays independently editable; re-exported here so every existing
// importer of comfyui.js keeps its import list unchanged.

export {
  ComfyImageGenConfigError,
  ComfyImageGenError,
  ComfyImageGenSizeError,
} from "./comfyui-errors.js";
export {
  COMFY_KREA2_CLIP_TYPE,
  COMFY_KREA2_DEFAULT_ENCODER,
  COMFY_KREA2_DEFAULT_VAE,
  COMFY_LORA_NODE_ID_BASE,
  COMFY_MODEL_TEMPLATES,
  COMFY_NODE_DEFAULTS,
  COMFY_NODE_IDS,
  buildComfyCheckpointWorkflow,
  buildComfyDitWorkflow,
  buildComfyKrea2Workflow,
} from "./comfyui-workflows.js";
export type {
  ComfyDitSidecars,
  ComfyKrea2Sidecars,
  ComfyLoraChainEntry,
  ComfySecondPassCtx,
  ComfyWorkflowGraph,
} from "./comfyui-workflows.js";
export {
  COMFY_FACE_DETAILER_DEFAULTS,
  COMFY_HIRES_DEFAULTS,
  applyComfyFaceDetailerPass,
  applyComfyHiresPass,
} from "./comfyui-second-passes.js";

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

/** The SaveImage node's output-rows container (top-level node outputs ride
 *  the history entry keyed by node id). */
interface ComfyHistoryOutputImage {
  filename: string;
  subfolder?: string;
  type?: string;
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
      "ComfyUI image-gen",
      ComfyImageGenError,
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

// ─── WS live progress (CG-C1) ────────────────────────────────────────────────

/** One run's live-progress snapshot — what `progress()` publishes. */
interface ComfyRunSnapshot {
  promptId: string;
  progress: number;
  state?: string;
}

/** Run snapshots keyed by ENDPOINT, module-level on purpose: every adapter
 *  method call runs on a FRESH backend instance, so the run's generate()
 *  must leave its state where the next poll's instance can read it (the
 *  a1111 twin gets the same for free from the server's own global
 *  /sdapi/v1/progress). One entry per endpoint, overwritten per run: a
 *  local ComfyUI executes one prompt at a time on the GPU and VT drives one
 *  generation at a time (the PG-2 poll-only-while-our-run contract). */
const comfyRunSnapshots = new Map<string, ComfyRunSnapshot>();

/** Handle to a run's WS listener. */
interface ComfyProgressListener {
  /** Bind the queue response's prompt id and replay buffered events — the
   *  socket opens BEFORE the prompt is queued, so early events can arrive
   *  pre-bind. */
  bindPromptId(promptId: string): void;
  /** Stop listening and close the socket (idempotent). */
  close(): void;
}

/** The default socket opener — the global WebSocket (Bun's does NOT read
 *  env proxies, so a localhost socket is always direct; correct here).
 *  Cast: the global satisfies the seam structurally, but its overloaded
 *  close() and `this`-typed handlers don't line up with the narrow
 *  interface for the checker — one documented boundary cast. */
const defaultOpenWebSocket = (url: string): ImageGenWebSocketLike =>
  new WebSocket(url) as unknown as ImageGenWebSocketLike;

/** http(s) endpoint → ws(s) socket URL with the run's client id. */
function comfyWsUrl(endpoint: string, clientId: string): string {
  const wsBase = endpoint.replace(/^http/, "ws");
  return `${wsBase}/ws?clientId=${encodeURIComponent(clientId)}`;
}

/** Open the run's WS listener. Best-effort by design (the A3 family-ladder
 *  degradation precedent): a socket that fails to open NEVER fails the
 *  generation — the run simply publishes no progress. */
function openComfyProgressListener(
  endpoint: string,
  clientId: string,
  openWebSocket: (url: string) => ImageGenWebSocketLike,
  onJobStarted?: () => void,
): ComfyProgressListener {
  let promptId: string | undefined;
  const buffer: string[] = [];
  let dead = false;
  // MR-11: the first step event attributed to THIS run's prompt_id flips
  // the phase registry to "steps" — exactly once, no matter how many
  // buffered events replay at bind time.
  let jobAnnounced = false;

  const applyEvent = (payload: unknown): void => {
    if (dead || !isObjectLike(payload)) return;
    const data = payload.data;
    const dataRecord = isObjectLike(data) ? data : undefined;
    // ComfyUI broadcasts execution events to EVERY connected socket — only
    // this run's prompt_id counts (the cross-prompt filter).
    if (promptId === undefined || dataRecord === undefined || dataRecord.prompt_id !== promptId) return;
    if (payload.type === "progress") {
      const value = typeof dataRecord.value === "number" && Number.isFinite(dataRecord.value) ? dataRecord.value : 0;
      const max = typeof dataRecord.max === "number" && dataRecord.max > 0 ? dataRecord.max : 0;
      if (max > 0) {
        const fraction = Math.min(Math.max(value / max, 0), 1);
        comfyRunSnapshots.set(endpoint, { promptId, progress: fraction, state: `step ${value}/${max}` });
        if (!jobAnnounced) {
          jobAnnounced = true;
          onJobStarted?.();
        }
      }
      return;
    }
    // `executing` with node === null and `execution_success` both mean the
    // prompt finished executing — the bar's 100%. (execution_error is left
    // alone: the failure surfaces through generate()'s own history
    // classification; the snapshot is informational.)
    if ((payload.type === "executing" && dataRecord.node === null) || payload.type === "execution_success") {
      comfyRunSnapshots.set(endpoint, { promptId, progress: 1 });
    }
  };

  const ingest = (raw: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // a malformed frame never breaks the run's progress feed
    }
    applyEvent(parsed);
  };

  let socket: ImageGenWebSocketLike;
  try {
    socket = openWebSocket(comfyWsUrl(endpoint, clientId));
  } catch {
    // Unopenable socket → a dead listener; the run degrades silently.
    return { bindPromptId() {}, close() {} };
  }
  socket.onmessage = (event) => {
    // Binary frames are live latent previews — ignored in v1 (documented
    // fast-follow; the step events are TEXT frames).
    if (dead || typeof event.data !== "string") return;
    if (promptId === undefined) {
      buffer.push(event.data);
      return;
    }
    ingest(event.data);
  };
  socket.onclose = () => {
    dead = true;
  };
  socket.onerror = () => {
    dead = true;
  };

  return {
    bindPromptId(id: string): void {
      if (dead || promptId !== undefined) return;
      promptId = id;
      for (const raw of buffer.splice(0)) ingest(raw);
    },
    close(): void {
      if (dead) return;
      dead = true;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // The socket is already gone — nothing to release.
      }
    },
  };
}

// ─── Model family ladder (CG-A3) ────────────────────────────────────

// Shared with the A1111 dialect since FT-A4: the family buckets and the
// embedded-metadata field precedence are ecosystem facts — one definition
// in model-family.ts keeps cross-dialect filter keys identical. The
// legacy export name stays for the pinned test surface.
export { normalizeModelFamily as normalizeComfyFamily } from "../model-family.js";
import { readEmbeddedFamilyValue, normalizeModelFamily } from "../model-family.js";
import { fetchOrWrap, setOrUndefined, sniffImageMime } from "./backend-helpers.js";

/** Sidecar stores after the embedded metadata misses, in precedence order
 *  (CG-A3, live-verified): `.cm-info.json` (Stability Matrix's store —
 *  top-level `BaseModel`, mirrors civitai plus the user's manual manager
 *  edits) before `.civitai.info` (the civitai download flow's de-facto
 *  standard — top-level `baseModel`). The stem rule on disk: the model
 *  filename minus its weights extension, sitting in the same directory. */
const COMFY_SIDECAR_STORES = [
  { suffix: ".cm-info.json", field: "BaseModel" },
  { suffix: ".civitai.info", field: "baseModel" },
] as const;

/** GET /view_metadata/{folder}?filename={name} → the metadata dict EMBEDDED
 *  in the safetensors header (trainer truth — the ladder's primary source).
 *  ANY failure degrades silently to undefined (the ladder's rule: an
 *  unreadable store must not fail the model list); the caller's abort is
 *  the one exception and propagates. */
async function fetchComfyEmbeddedFamily(
  transport: typeof fetch,
  endpoint: string,
  folder: string,
  name: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  let parsed: unknown;
  try {
    const response = await fetchOrWrap(
      transport,
      `${endpoint}/view_metadata/${encodeURIComponent(folder)}?filename=${encodeURIComponent(name)}`,
      { method: "GET", headers: { Accept: "application/json" }, signal },
      "model metadata",
      "ComfyUI image-gen",
      ComfyImageGenError,
    );
    if (!response.ok) return undefined;
    parsed = await response.json().catch(() => undefined);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return undefined;
  }
  if (!isObjectLike(parsed)) return undefined;
  return readEmbeddedFamilyValue(parsed);
}

/** GET /internal/folder_paths → the folder-name → root-paths map ComfyUI
 *  itself resolves (including launcher-shared dirs via
 *  extra_model_paths.yaml). Officially "frontend use only" — it is a BONUS
 *  source for the sidecar join, so any failure (404 on hardened remotes,
 *  transport error, unexpected shape) degrades silently to undefined and
 *  the ladder stays embedded-only (the plan's remote-host rule). */
async function fetchComfyFolderRoots(
  transport: typeof fetch,
  endpoint: string,
  signal: AbortSignal | undefined,
): Promise<Record<string, string[]> | undefined> {
  let parsed: unknown;
  try {
    const response = await fetchOrWrap(
      transport,
      `${endpoint}/internal/folder_paths`,
      { method: "GET", headers: { Accept: "application/json" }, signal },
      "folder map",
      "ComfyUI image-gen",
      ComfyImageGenError,
    );
    if (!response.ok) return undefined;
    parsed = await response.json().catch(() => undefined);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return undefined;
  }
  if (!isObjectLike(parsed)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [folder, roots] of Object.entries(parsed)) {
    if (Array.isArray(roots)) {
      const clean = roots.filter((root): root is string => typeof root === "string" && root.length > 0);
      if (clean.length > 0) out[folder] = clean;
    }
  }
  return out;
}

/** IPT-3 detection twin of fetchComfyEmbeddedFamily: a 404 IS the honest
 *  no-label answer (the installed core's /view_metadata 404s when the
 *  safetensors header carries no `__metadata__` — server.py returns 404
 *  by design there), so it resolves undefined; every OTHER failure
 *  (non-404 status, transport, unparseable 200 body) THROWS the typed
 *  error so the ladder records the real reason at source (a). The
 *  listing twin keeps its silent degradation — both behaviors are
 *  intentional, one per consumer. */
async function fetchComfyEmbeddedFamilyForDetection(
  transport: typeof fetch,
  endpoint: string,
  folder: string,
  name: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const response = await fetchOrWrap(
    transport,
    `${endpoint}/view_metadata/${encodeURIComponent(folder)}?filename=${encodeURIComponent(name)}`,
    { method: "GET", headers: { Accept: "application/json" }, signal },
    "model metadata",
    "ComfyUI image-gen",
    ComfyImageGenError,
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    const excerpt = await readProviderErrorBody(response);
    throw new ComfyImageGenError(
      `ComfyUI model metadata failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
      { status: response.status },
    );
  }
  const parsed: unknown = await response.json().catch(() => null);
  if (!isObjectLike(parsed)) {
    throw new ComfyImageGenError("ComfyUI /view_metadata response was not a JSON object");
  }
  return readEmbeddedFamilyValue(parsed);
}

/** IPT-3 detection twin of fetchComfyFolderRoots: a 404 is the structural
 *  no-anchor answer (hardened remotes legitimately expose no folder map —
 *  roots stay absent); every other failure returns its REASON so the
 *  reader records it on `sidecarError` and source (b) tells the real
 *  story instead of the structural "no path exposed" text. */
async function fetchComfyFolderRootsForDetection(
  transport: typeof fetch,
  endpoint: string,
  signal: AbortSignal | undefined,
): Promise<{ roots?: Record<string, string[]>; error?: string }> {
  let parsed: unknown;
  try {
    const response = await fetchOrWrap(
      transport,
      `${endpoint}/internal/folder_paths`,
      { method: "GET", headers: { Accept: "application/json" }, signal },
      "folder map",
      "ComfyUI image-gen",
      ComfyImageGenError,
    );
    if (response.status === 404) return {};
    if (!response.ok) {
      const excerpt = await readProviderErrorBody(response);
      return {
        error: `ComfyUI folder map failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
      };
    }
    parsed = await response.json().catch(() => null);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {
      error: `ComfyUI folder map fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isObjectLike(parsed)) {
    return { error: "ComfyUI /internal/folder_paths response was not a JSON object" };
  }
  const out: Record<string, string[]> = {};
  for (const [folder, roots] of Object.entries(parsed)) {
    if (Array.isArray(roots)) {
      const clean = roots.filter((root): root is string => typeof root === "string" && root.length > 0);
      if (clean.length > 0) out[folder] = clean;
    }
  }
  return { roots: out };
}

/** Read one sidecar store's family field off the local disk: the model's
 *  directory (subfolder part of the id, separators normalized) joined
 *  against each folder root until the file exists and parses. A miss,
 *  unreadable file, or wrong shape returns undefined — the ladder
 *  continues (a remote ComfyUI's roots simply do not exist locally). */
async function readComfySidecarFamily(
  roots: readonly string[],
  name: string,
  suffix: string,
  field: string,
): Promise<string | undefined> {
  const normalized = name.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const file = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const stem = file.replace(/\.(safetensors|ckpt|pt|pth|gguf|bin|sft)$/i, "");
  if (stem.length === 0) return undefined;
  const relative = `${slash >= 0 ? `${normalized.slice(0, slash)}/` : ""}${stem}${suffix}`;
  for (const root of roots) {
    try {
      const text = await Bun.file(`${root.replace(/[\\/]+$/, "")}/${relative}`).text();
      const parsed: unknown = JSON.parse(text);
      if (isObjectLike(parsed)) {
        const raw = parsed[field];
        if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
      }
    } catch {
      // Missing or unparseable sidecar — the ladder's next root/store.
      continue;
    }
  }
  return undefined;
}

/** Resolve one model's family through the full ladder (CG-A3):
 *  embedded safetensors metadata → `.cm-info.json` → `.civitai.info` →
 *  undefined ("unknown family" bucket). Every store degrades silently;
 *  only the caller's abort propagates. `rootsOf` lazily fetches (once per
 *  listing) the folder-roots map and only when the first sidecar lookup is
 *  actually needed — a fully-embedded resolution costs no extra call. */
async function resolveComfyModelFamily(
  transport: typeof fetch,
  endpoint: string,
  options: {
    folder: string;
    name: string;
    signal: AbortSignal | undefined;
    rootsOf: () => Promise<Record<string, string[]> | undefined>;
  },
): Promise<string | undefined> {
  const embedded = normalizeModelFamily(
    await fetchComfyEmbeddedFamily(transport, endpoint, options.folder, options.name, options.signal),
  );
  if (embedded !== undefined) return embedded;
  const roots = (await options.rootsOf())?.[options.folder] ?? [];
  if (roots.length === 0) return undefined;
  for (const store of COMFY_SIDECAR_STORES) {
    const raw = await readComfySidecarFamily(roots, options.name, store.suffix, store.field);
    const normalized = normalizeModelFamily(raw);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

/** Trigger-word sidecar stores, in precedence order (CG-C2, live-verified
 *  on the owner's install 2026-09-18): `.cm-info.json` `TrainedWords`
 *  (Stability Matrix's mirror — populated on civitai imports, null on
 *  manual adds) before `.civitai.info` `trainedWords` (the download
 *  flow's own store). No embedded rung: kohya's `ss_tag_frequency` is a
 *  frequency heuristic the owner's leading lora doesn't even carry —
 *  deliberately out (recorded, CG-C3 decision log). */
const COMFY_LORA_TRIGGER_STORES = [
  { suffix: ".cm-info.json", field: "TrainedWords" },
  { suffix: ".civitai.info", field: "trainedWords" },
] as const;

/** Read one sidecar store's trigger-word array off the local disk — the
 *  same stem/subfolder join as the family store. A missing field, wrong
 *  shape, or all-empty strings returns undefined (the ladder continues);
 *  entries are kept VERBATIM (civitai comma-phrases included). */
async function readComfySidecarTriggerWords(
  roots: readonly string[],
  name: string,
  suffix: string,
  field: string,
): Promise<string[] | undefined> {
  const normalized = name.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const file = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const stem = file.replace(/\.(safetensors|ckpt|pt|pth|gguf|bin|sft)$/i, "");
  if (stem.length === 0) return undefined;
  const relative = `${slash >= 0 ? `${normalized.slice(0, slash)}/` : ""}${stem}${suffix}`;
  for (const root of roots) {
    try {
      const text = await Bun.file(`${root.replace(/[\\/]+$/, "")}/${relative}`).text();
      const parsed: unknown = JSON.parse(text);
      if (isObjectLike(parsed)) {
        const raw = parsed[field];
        if (Array.isArray(raw)) {
          const words = raw.filter((w): w is string => typeof w === "string" && w.trim().length > 0)
            .map((w) => w.trim());
          if (words.length > 0) return words;
        }
      }
    } catch {
      // Missing or unparseable sidecar — the ladder's next root/store.
      continue;
    }
  }
  return undefined;
}

/** Resolve one lora's activation words through the sidecar stores (CG-C2):
 *  cm-info → civitai.info → [] (none found). Silent per-store degradation;
 *  only the caller's abort propagates. No transport — the stores are read
 *  off the local disk through the lazily-fetched folder roots. */
async function resolveComfyLoraTriggers(options: {
  name: string;
  signal: AbortSignal | undefined;
  rootsOf: () => Promise<Record<string, string[]> | undefined>;
}): Promise<string[]> {
  const roots = (await options.rootsOf())?.["loras"] ?? [];
  if (roots.length === 0) return [];
  for (const store of COMFY_LORA_TRIGGER_STORES) {
    const words = await readComfySidecarTriggerWords(roots, options.name, store.suffix, store.field);
    if (words !== undefined) return words;
  }
  return [];
}

// ─── Config ──────────────────────────────────────────────────────────────────

interface ComfyImageGenConfig {
  endpoint: string;
  model: string | undefined;
  fetch: typeof fetch;
  openWebSocket: (url: string) => ImageGenWebSocketLike;
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
    openWebSocket: config.openWebSocket ?? defaultOpenWebSocket,
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
          "ComfyUI image generation requires a selected model (the workflow graph names its checkpoint or diffusion model)",
        );
      }
      // LoRA validation (CG-C2): every enabled lora must exist in the live
      // LoraLoader combo — the model-list precedent (fail closed naming the
      // entry, never a queue-time node_errors blob). Skipped entirely when
      // the run carries no loras (zero extra calls on the common path).
      const loras = request.loras ?? [];
      if (loras.length > 0) {
        const loraNames = await fetchComfyComboValues(
          cfg.fetch,
          cfg.endpoint,
          "LoraLoader",
          "lora_name",
          request.signal,
        );
        for (const lora of loras) {
          if (!loraNames.includes(lora.name)) {
            throw new ComfyImageGenConfigError(
              `ComfyUI lora "${lora.name}" is not in the loras folder — reselect it from the lora list`,
            );
          }
        }
      }
      // The base-workflow pick (a sampler set's `workflowFamily`) is the ONE
      // manual template channel (IF-19b, owner 2026-09-29): it outranks
      // metadata detection; the prompt-family pin chooses only the prompt
      // dialect and never a graph. Without a pick, the loader-folder +
      // CG-A3 metadata ladder decides.
      const manualSpec = request.workflowFamily === undefined
        ? undefined
        : resolveComfyManualWorkflowTemplate(request.workflowFamily);
      const checkpointNames = manualSpec === undefined
        ? await fetchComfyComboValues(
          cfg.fetch,
          cfg.endpoint,
          "CheckpointLoaderSimple",
          "ckpt_name",
          request.signal,
        )
        : [];
      let template: (typeof COMFY_MODEL_TEMPLATES)[keyof typeof COMFY_MODEL_TEMPLATES];
      let graph: ComfyWorkflowGraph;
      let secondPassCtx: ComfySecondPassCtx;
      if (
        manualSpec === COMFY_TEMPLATE_SPECS.checkpoint ||
        (manualSpec === undefined && checkpointNames.includes(model))
      ) {
        ({ graph, ctx: secondPassCtx } = buildComfyCheckpointWorkflow(request, model));
        template = COMFY_MODEL_TEMPLATES.checkpoint;
      } else {
        let spec: ComfyDitTemplateSpec;
        if (manualSpec !== undefined) {
          if (!isComfyManualDitTemplate(manualSpec)) {
            throw new ComfyImageGenConfigError(`ComfyUI workflow family "${request.workflowFamily}" has no DiT template`);
          }
          spec = manualSpec;
        } else {
          const unetNames = await fetchComfyComboValues(
            cfg.fetch,
            cfg.endpoint,
            "UNETLoader",
            "unet_name",
            request.signal,
          );
          if (!unetNames.includes(model)) {
            throw new ComfyImageGenConfigError(
              `ComfyUI model "${model}" is in neither the checkpoints nor the diffusion-models folder — reselect it from the model list`,
            );
          }
          // Reuse the CG-A3 metadata ladder for auto routing. Its embedded
          // metadata and sidecar stores are authoritative; no filename guess
          // can select a workflow graph.
          let folderRoots: Record<string, string[]> | undefined;
          let folderRootsFetched = false;
          const rootsOf = async (): Promise<Record<string, string[]> | undefined> => {
            if (!folderRootsFetched) {
              folderRoots = await fetchComfyFolderRoots(cfg.fetch, cfg.endpoint, request.signal);
              folderRootsFetched = true;
            }
            return folderRoots;
          };
          const family = await resolveComfyModelFamily(cfg.fetch, cfg.endpoint, {
            folder: "diffusion_models",
            name: model,
            signal: request.signal,
            rootsOf,
          });
          spec = resolveComfyAutoDiffusionTemplate(family, model);
        }
        const listFolder = (folder: string, signal: AbortSignal | undefined) =>
          fetchComfyFolderNames(cfg.fetch, cfg.endpoint, folder, signal);
        const createConfigError = (message: string) => new ComfyImageGenConfigError(message);
        const encoder = await resolveComfySidecar(
          {
            folder: "text_encoders",
            explicit: request.encoderName,
            canonical: spec.canonicalEncoder,
            canonicalAliases: spec.canonicalEncoderAliases,
            pairedStem: model,
            what: "text encoder",
            signal: request.signal,
            listFolder,
            createConfigError,
          },
          spec,
        );
        const secondaryEncoder = spec.canonicalSecondaryEncoder === undefined
          ? undefined
          : await resolveComfySidecar(
            {
              folder: "text_encoders",
              explicit: undefined,
              canonical: spec.canonicalSecondaryEncoder,
              pairedStem: undefined,
              what: "second text encoder",
              signal: request.signal,
              listFolder,
              createConfigError,
            },
            spec,
          );
        const vae = await resolveComfySidecar(
          {
            folder: "vae",
            explicit: request.vaeName,
            canonical: spec.canonicalVae,
            canonicalAliases: spec.canonicalVaeAliases,
            pairedStem: undefined,
            what: "VAE",
            signal: request.signal,
            listFolder,
            createConfigError,
          },
          spec,
        );
        if (spec === COMFY_TEMPLATE_SPECS.krea2Dit || spec === COMFY_TEMPLATE_SPECS.animaDit) {
          ({ graph, ctx: secondPassCtx } = buildComfyKrea2Workflow(request, { unet: model, encoder, vae }, spec));
        } else {
          ({ graph, ctx: secondPassCtx } = buildComfyDitWorkflow(
            request,
            { unet: model, encoder, vae, ...(secondaryEncoder !== undefined ? { secondaryEncoder } : {}) },
            spec,
          ));
          if (
            spec.workflowShape === COMFY_DIT_WORKFLOW_SHAPES.FluxSchnell &&
            (request.hires !== undefined || request.adetailer === true)
          ) {
            throw new ComfyImageGenConfigError(
              "ComfyUI FLUX.1-schnell's stock workflow has no negative conditioning, so hires and face detailing are unavailable",
            );
          }
        }
        template = comfyTemplateMarker(spec);
      }

      // Hires second pass (FT-A4 flat field, comfy dialect): a NAMED
      // upscaler is validated against the live upscale_models folder (the
      // lora fail-closed precedent — reselect, never a queue-time blob);
      // unset (the chip's Auto) takes the latent path with no extra call.
      let finalImage: [string, number] = [COMFY_NODE_IDS.vaeDecode, 0];
      if (request.hires !== undefined) {
        const upscaler = setOrUndefined(request.hires.upscaler);
        if (upscaler !== undefined) {
          const upscalerNames = await fetchComfyFolderNames(
            cfg.fetch,
            cfg.endpoint,
            "upscale_models",
            request.signal,
          );
          if (!upscalerNames.includes(upscaler)) {
            throw new ComfyImageGenConfigError(
              `ComfyUI upscaler "${upscaler}" is not in the upscale_models folder — reselect it from the hires upscaler list`,
            );
          }
        }
        finalImage = applyComfyHiresPass(graph, request, secondPassCtx).finalImage;
      }
      // Face detailing (IF-6, comfy dialect — the ADetailer equivalent):
      // the request boolean is the ONLY switch (owner defect report
      // 2026-09-27: toggle OFF + a configured detector name still ran the
      // second pass — the name is configured-but-DISABLED state, the hires
      // pattern, never an activator); the model is the EXPLICIT pick or
      // this dialect's own default — the live list's FIRST entry (the pane
      // control's fallback mirror), never a cross-dialect constant. The
      // Impact Pack FaceDetailer node must exist (honest config error
      // naming the pack, never a queue-time blob) and an explicit pick
      // must be in the discovered face list (the lora fail-closed
      // precedent).
      const faceDetectorExplicit = setOrUndefined(request.adetailerModel);
      if (request.adetailer === true) {
        if (!(await comfyNodeClassExists(cfg.fetch, cfg.endpoint, "FaceDetailer", request.signal))) {
          throw new ComfyImageGenConfigError(
            "ComfyUI face detailing requires the Impact Pack — the FaceDetailer node was not found on the server",
          );
        }
        const detectors = await fetchComfyFaceDetectors(cfg.fetch, cfg.endpoint, request.signal);
        const faceDetector = faceDetectorExplicit ?? detectors[0];
        if (faceDetector === undefined || !detectors.includes(faceDetector)) {
          const candidates =
            detectors.length === 0
              ? "no face bbox models were found in the ultralytics folder"
              : `available: ${detectors.slice(0, 5).join(", ")}${detectors.length > 5 ? ", …" : ""}`;
          throw new ComfyImageGenConfigError(
            `ComfyUI detector "${faceDetector ?? "(unset)"}" is not in the discovered list (${candidates}) — reselect it from the detector list`,
          );
        }
        applyComfyFaceDetailerPass(graph, request, { ...secondPassCtx, finalImage, detector: faceDetector });
      }

      const clientId = crypto.randomUUID();
      // The WS live-progress listener (CG-C1): opened BEFORE the prompt is
      // queued so no early event is missed, held through execution, closed
      // at run end. Best-effort — its failure never fails the run.
      const listener = openComfyProgressListener(cfg.endpoint, clientId, cfg.openWebSocket, request.onJobStarted);
      let promptId: string;
      let outputImages: ComfyHistoryOutputImage[];
      try {
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
          "ComfyUI image-gen",
          ComfyImageGenError,
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
        const queuedPromptId = queuedRecord.prompt_id;
        if (typeof queuedPromptId !== "string" || queuedPromptId.length === 0) {
          throw new ComfyImageGenError("ComfyUI prompt queue response carried no prompt_id");
        }
        promptId = queuedPromptId;
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

        // MR-11: a fresh run must not inherit the previous run's terminal
        // 100% — the reset lands BEFORE the bind replays buffered events, so
        // pre-queue frames still win (the queue/model-load span otherwise
        // reads "starting", never a stale percent).
        comfyRunSnapshots.set(cfg.endpoint, { promptId, progress: 0 });
        listener.bindPromptId(promptId);
        outputImages = await waitForPromptCompletion(cfg.fetch, cfg.endpoint, promptId, request.signal);
      } finally {
        listener.close();
      }
      // History completion is the authoritative terminal signal — stamp the
      // bar's 100% even when the socket's own terminal event lagged or the
      // socket died mid-run (the poll ends with the run either way).
      comfyRunSnapshots.set(cfg.endpoint, { promptId, progress: 1 });

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
          "ComfyUI image-gen",
          ComfyImageGenError,
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
        // /view serves without a reliable Content-Type; PNG is the
        // SaveImage default and the fallback.
        images.push({ data, mimeType: sniffImageMime(data) ?? "image/png" });
      }

      // Wire meaning of what was sent (the a1111 twin): W/H echo
      // independently; the seed is the graph's own resolved value; the
      // resolved template id rides for the slot provenance (CG-A2).
      const result: ImageGenGenerateResult = { images, seed: secondPassCtx.seed, resolvedTemplate: template };
      if (request.width !== undefined) result.width = request.width;
      if (request.height !== undefined) result.height = request.height;
      return result;
    },

    async listModels(signal?: AbortSignal): Promise<ImageGenModelInfo[]> {
      // The model union (CG-A3): checkpoints ∪ diffusion models — the two
      // folders the two templates load from. `id` keeps the server's path
      // VERBATIM (round-trips into ckpt_name/unet_name byte-identically,
      // subfolder separators included); `label` is the basename without the
      // weights extension; `template` marks which workflow the adapter
      // resolves; `family` rides the metadata ladder with silent
      // degradation (an unreadable store never fails the list).
      const checkpointNames = await fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "checkpoints", signal);
      const unetNames = await fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "diffusion_models", signal);
      // Folder roots for the sidecar join — fetched lazily, ONCE per
      // listing, and only when the first model actually needs a sidecar.
      let folderRoots: Record<string, string[]> | undefined;
      let folderRootsFetched = false;
      const rootsOf = async (): Promise<Record<string, string[]> | undefined> => {
        if (!folderRootsFetched) {
          folderRoots = await fetchComfyFolderRoots(cfg.fetch, cfg.endpoint, signal);
          folderRootsFetched = true;
        }
        return folderRoots;
      };
      const entries: ImageGenModelInfo[] = [];
      const folders: Array<{ folder: string; names: string[]; template: string }> = [
        { folder: "checkpoints", names: checkpointNames, template: COMFY_MODEL_TEMPLATES.checkpoint },
        { folder: "diffusion_models", names: unetNames, template: COMFY_MODEL_TEMPLATES.krea2Dit },
      ];
      for (const { folder, names, template } of folders) {
        for (const name of names) {
          const family = await resolveComfyModelFamily(cfg.fetch, cfg.endpoint, {
            folder,
            name,
            signal,
            rootsOf,
          });
          const label = comfyWeightsBasename(name);
          const resolvedTemplate = folder === "diffusion_models"
            ? resolveComfyListedDiffusionTemplate(family)
            : template;
          entries.push({
            id: name,
            label: label.length > 0 ? label : name,
            ...(family !== undefined ? { family } : {}),
            ...(resolvedTemplate !== undefined ? { template: resolvedTemplate } : {}),
          });
        }
      }
      return entries;
    },

    async listSamplers(signal?: AbortSignal): Promise<ImageGenSamplerInfo[]> {
      // The live KSampler sampler union (CG-A3) — the same /object_info
      // combo walk template detection uses; bare enums, no aliases.
      const names = await fetchComfyComboValues(
        cfg.fetch,
        cfg.endpoint,
        "KSampler",
        "sampler_name",
        signal,
      );
      return names.map((name) => ({ name }));
    },

    async listSchedulers(signal?: AbortSignal): Promise<ImageGenSchedulerInfo[]> {
      // The live KSampler scheduler union (CG-A3) — bare enums, no labels.
      const names = await fetchComfyComboValues(
        cfg.fetch,
        cfg.endpoint,
        "KSampler",
        "scheduler",
        signal,
      );
      return names.map((name) => ({ name }));
    },

    async listDitSidecars(signal?: AbortSignal): Promise<ImageGenDitSidecars> {
      // The live DiT sidecar folders (CG-B1) — the same catalogs the
      // generate path resolves canonical sidecars against; both fetched in
      // parallel (independent folders, one round-trip each).
      const [encoders, vaes] = await Promise.all([
        fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "text_encoders", signal),
        fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "vae", signal),
      ]);
      return { encoders, vaes };
    },

    async listUpscalers(signal?: AbortSignal): Promise<ImageGenUpscalerInfo[]> {
      // The hires-upscaler vocabulary (FT-A4, comfy dialect): the live
      // upscale_models folder (the /models route — the per-node combo is
      // combo-truncated on 0.37+, the checkpoints-list precedent's source).
      // The chip's Auto ("") is the LATENT path — adapter-side, no entry.
      const names = await fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "upscale_models", signal);
      return names.map((name) => ({ name }));
    },

    async listVae(signal?: AbortSignal): Promise<string[]> {
      // IF-7b: the live vae folder — the SAME catalog the DiT sidecar
      // resolver uses; here it feeds the checkpoint template's VAE-swap
      // field too (one folder, both templates' vocabulary).
      return fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "vae", signal);
    },

    async listFaceDetectors(signal?: AbortSignal): Promise<string[]> {
      // The IF-6 chain probe: BOTH links must hold — the Impact Pack's
      // FaceDetailer node exists AND the ultralytics folder/combo carries
      // at least one face bbox model. Either miss = [] (the honest
      // unavailable signal the picker gates on).
      if (!(await comfyNodeClassExists(cfg.fetch, cfg.endpoint, "FaceDetailer", signal))) return [];
      return fetchComfyFaceDetectors(cfg.fetch, cfg.endpoint, signal);
    },

    async listLoras(signal?: AbortSignal): Promise<ImageGenLoraInfo[]> {
      // The lora list (CG-C2): names from the live LoraLoader combo (what
      // ComfyUI itself validates at queue time), family through the SAME
      // three-store ladder as models (folder "loras"), NULL = the ladder
      // found nothing (the chip's unknown-family bucket — never a guess).
      const names = await fetchComfyComboValues(
        cfg.fetch,
        cfg.endpoint,
        "LoraLoader",
        "lora_name",
        signal,
      );
      let folderRoots: Record<string, string[]> | undefined;
      let folderRootsFetched = false;
      const rootsOf = async (): Promise<Record<string, string[]> | undefined> => {
        if (!folderRootsFetched) {
          folderRoots = await fetchComfyFolderRoots(cfg.fetch, cfg.endpoint, signal);
          folderRootsFetched = true;
        }
        return folderRoots;
      };
      const entries: ImageGenLoraInfo[] = [];
      for (const name of names) {
        const family = await resolveComfyModelFamily(cfg.fetch, cfg.endpoint, {
          folder: "loras",
          name,
          signal,
          rootsOf,
        });
        // Activation words (owner-directed pull-forward 2026-09-18): the
        // sidecar stores only — discovered, never hardcoded.
        const triggerWords = await resolveComfyLoraTriggers({
          name,
          signal,
          rootsOf,
        });
        entries.push({ name, family: family ?? null, triggerWords });
      }
      return entries;
    },

    async readModelDetectionMetadata(
      model: string,
      signal?: AbortSignal,
    ): Promise<ImageGenModelDetectionMetadata> {
      // IPT-3 source (a): locate the model's folder (the listModels union
      // walk for ONE model — /models/checkpoints before
      // /models/diffusion_models, the common sync-checkpoint case first),
      // then read the embedded safetensors `__metadata__` through the
      // backend's own /view_metadata surface (authoritative trainer
      // truth). Core ComfyUI exposes NO hash — the Civitai source's
      // anchor stays absent on this dialect (an honest miss).
      //
      // Failure honesty (IPT-3 review): the DETECTION twins below THROW
      // or carry reasons — the listing helpers' silent degradation stays
      // for the picker/list paths it was built for. /view_metadata 404 IS
      // the honest no-label answer (the installed core 404s when the
      // header carries no __metadata__); /internal/folder_paths 404 is
      // the structural no-anchor answer (hardened remotes); anything
      // else records the real reason at the source it failed.
      const checkpointNames = await fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "checkpoints", signal);
      const folder = checkpointNames.includes(model)
        ? "checkpoints"
        : (await fetchComfyFolderNames(cfg.fetch, cfg.endpoint, "diffusion_models", signal)).includes(model)
          ? "diffusion_models"
          : undefined;
      if (folder === undefined) {
        throw new ComfyImageGenConfigError(
          `ComfyUI model "${model}" is in neither the checkpoints nor the diffusion-models folder — reselect it from the model list`,
        );
      }
      const metadata: ImageGenModelDetectionMetadata = {};
      // Embedded read: a non-abort failure is CARRIED (metadataError),
      // not thrown — the folder-map anchor below stays obtainable for
      // source (b) even when /view_metadata itself errored, and the
      // rethrow-at-the-end pattern would discard it (the ladder drops
      // metadata on a reader throw).
      let embeddedError: Error | undefined;
      try {
        const embedded = await fetchComfyEmbeddedFamilyForDetection(
          cfg.fetch,
          cfg.endpoint,
          folder,
          model,
          signal,
        );
        if (embedded !== undefined) metadata.baseModel = embedded;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        embeddedError = error instanceof Error ? error : new Error(String(error));
      }
      // Sidecar join anchor: the folder roots the backend itself reports
      // via /internal/folder_paths (officially frontend-only — a bonus
      // source). Fetched EAGERLY: an embedded label that maps is the
      // common short-circuit, but an embedded miss OR an unmappable
      // embedded label (e.g. a bare SDXL architecture stamp) must still
      // let the sidecar source run — the ladder's correctness beats
      // saving one localhost round-trip. A failed map fetch records its
      // reason on sidecarError so source (b) tells the real story.
      const folderMap = await fetchComfyFolderRootsForDetection(cfg.fetch, cfg.endpoint, signal);
      if (folderMap.error !== undefined) {
        metadata.sidecarError = folderMap.error;
      } else {
        const roots = folderMap.roots?.[folder] ?? [];
        if (roots.length > 0) metadata.sidecar = { roots, relativeName: model };
      }
      if (embeddedError !== undefined) {
        metadata.metadataError = `backend metadata read failed: ${embeddedError.message}`;
      }
      return metadata;
    },

    /** Publish the run's WS-fed snapshot (CG-C1). No snapshot (idle
     *  server, socket never opened) = an honest 0 — the poll only runs
     *  while a VT generation is in flight, so 0 reads as "no steps
     *  observed yet", never a fake cloud bar. */
    async progress(): Promise<ImageGenProgressInfo> {
      const snapshot = comfyRunSnapshots.get(cfg.endpoint);
      if (snapshot === undefined) return { progress: 0 };
      return snapshot.state === undefined
        ? { progress: snapshot.progress }
        : { progress: snapshot.progress, state: snapshot.state };
    },

    /** Cancel the instance's current job — POST /interrupt, the a1111
     *  twin (instance-global on a single-user local server). */
    async interrupt(signal?: AbortSignal): Promise<void> {
      const response = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/interrupt`,
        { method: "POST", headers: { Accept: "application/json" }, signal },
        "interrupt",
        "ComfyUI image-gen",
        ComfyImageGenError,
      );
      if (!response.ok) {
        const excerpt = await readProviderErrorBody(response);
        throw new ComfyImageGenError(
          `ComfyUI interrupt failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: response.status },
        );
      }
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
      // Stateless: the WS progress listener is scoped to a single
      // generate() run and closed in its finally — nothing outlives a run
      // (the registry entry it wrote is a plain map slot, GC'd on
      // overwrite by the next run).
    },
  };

  return backend;
};

// Module-scope registration (protocol-registry pattern, the a1111 twin):
// importing this module makes the 'comfyui' image-gen slug creatable via
// the image-gen registry.
registerImageGenBackend(IMAGE_GEN_BACKENDS.ComfyUI, comfyImageGenFactory);
