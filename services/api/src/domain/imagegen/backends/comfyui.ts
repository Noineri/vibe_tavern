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
 * The /history completion poll lives in comfyui-history.ts, the WS
 * live-progress listener in comfyui-progress.ts, and the model-family
 * ladder in comfyui-model-detection.ts — same re-export rule (IG-R3).
 * The config parser lives in comfyui-config.ts and the read-only
 * listing methods in comfyui-catalog.ts (IG-R3b: internal moves — the
 * factory parses and delegates, so no re-export is needed).
 *
 * Doc gate (every wire fact below live-verified on the owner's ComfyUI
 * 0.36.0 / Stability Matrix instance, 2026-09-18 — probe scripts in
 * reports/IMAGEGEN_POLISH_REPORT.md § PG-5):
 * - generation: `POST /prompt` with `{prompt: <workflow graph>, client_id}`
 *   → `{prompt_id, number, node_errors}`. A NON-EMPTY `node_errors` object
 *   means the graph was rejected (bad ckpt_name etc.) — surfaced as a
 *   caller-class error (status 400 on the adapter error): the request
 *   content is wrong, not the gateway.
 * - download: `GET /view?filename=&subfolder=&type=output` → raw image
 *   bytes (SaveImage emits PNG; MIME sniffs as a fallback).
 * - model list: `GET /models/checkpoints` + `GET /models/diffusion_models`
 *   → the UNION the picker serves (CG-A3): checkpoints first, then DiT
 *   models, each entry carrying its `template` marker. Ids keep the
 *   server's path VERBATIM (subfolder entries ride the server's own
 *   separator — the round-trip back into `ckpt_name`/`unet_name` must be
 *   byte-identical).
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
  ImageGenProbeResult,
  ImageGenProgressInfo,
} from "../imagegen-backend.js";
import { registerImageGenBackend } from "../imagegen-registry.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";
import {
  COMFY_DIT_WORKFLOW_SHAPES,
  COMFY_TEMPLATE_SPECS,
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
import { fetchComfyComboValues, fetchComfyFolderNames } from "./comfyui-listing.js";
import { fetchOrWrap, setOrUndefined, sniffImageMime } from "./backend-helpers.js";
import { waitForPromptCompletion } from "./comfyui-history.js";
import type { ComfyHistoryOutputImage } from "./comfyui-history.js";
import { comfyRunSnapshots, openComfyProgressListener } from "./comfyui-progress.js";
import { fetchComfyFolderRoots, resolveComfyModelFamily } from "./comfyui-model-detection.js";
import { parseConfig } from "./comfyui-config.js";
import {
  listComfyDitSidecars,
  listComfyFaceDetectors,
  listComfyLoras,
  listComfyModels,
  listComfySamplers,
  listComfySchedulers,
  listComfyUpscalers,
  listComfyVae,
  readComfyModelDetectionMetadata,
} from "./comfyui-catalog.js";

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

// ─── Moved-out sections, re-exported (IG-R3) ────────────────────────────────
// The /history completion poll, the WS live-progress listener, and the
// model-family ladder moved to sibling modules so each stays
// independently editable; re-exported here so every existing importer
// of comfyui.js keeps its import list unchanged.

export { COMFY_HISTORY_POLL_INTERVAL_MS } from "./comfyui-history.js";
export { normalizeComfyFamily } from "./comfyui-model-detection.js";

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

    // The read-only catalog listings live in comfyui-catalog.ts (IG-R3b)
    // — each delegates with the same signature the backend object exposes.
    listModels: (signal?: AbortSignal) => listComfyModels(cfg, signal),
    listSamplers: (signal?: AbortSignal) => listComfySamplers(cfg, signal),
    listSchedulers: (signal?: AbortSignal) => listComfySchedulers(cfg, signal),
    listDitSidecars: (signal?: AbortSignal) => listComfyDitSidecars(cfg, signal),
    listUpscalers: (signal?: AbortSignal) => listComfyUpscalers(cfg, signal),
    listVae: (signal?: AbortSignal) => listComfyVae(cfg, signal),
    listFaceDetectors: (signal?: AbortSignal) => listComfyFaceDetectors(cfg, signal),
    listLoras: (signal?: AbortSignal) => listComfyLoras(cfg, signal),
    readModelDetectionMetadata: (model: string, signal?: AbortSignal) =>
      readComfyModelDetectionMetadata(cfg, model, signal),

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
