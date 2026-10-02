/**
 * @module imagegen/backends/dashscope
 *
 * Alibaba DashScope / Model Studio image backend (IMAGEGEN_PROVIDER_
 * EXPANSION_PLAN wave PE-2 unit 4) — the CHAT-SHAPED JSON surface (NOT the
 * OpenAI-images transport): request bodies are `input.messages[]` +
 * `parameters{}`, two transports split by model family, and delivery is a
 * 24-hour OSS URL downloaded server-side.
 *
 * Wire facts (card IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "DashScope intl",
 * doc-verified 2026-09-07; re-verified 2026-09-18 with the live API
 * reference pages re-read — z-image API reference, wan2.7 image generation
 * and editing API reference, text-to-image guide — + live existence probes
 * of both paths on the intl non-workspace domain, both 401 auth walls):
 *
 * - Transport: base `https://dashscope-intl.aliyuncs.com/api/v1` (the
 *   documented intl non-workspace domain — live-probed; the guide's
 *   workspace form `https://{WorkspaceId}.{region}.maas.aliyuncs.com/api/v1`
 *   also works and is what a user with a workspace pastes instead),
 *   `Authorization: Bearer sk-…`.
 * - SYNC `POST /services/aigc/multimodal-generation/generation`:
 *   `qwen-image-3.0-pro` (flagship, prompt rewriting, CJK+EN text) and
 *   `z-image-turbo` (fast, ~1/5 cost) — both documented on this endpoint
 *   by their own API references.
 * - ASYNC `POST /services/aigc/image-generation/generation` with header
 *   `X-DashScope-Async: enable`: `wan2.7-image-pro` (up to 4096², image
 *   sets). Submit → `{output: {task_id, task_status: PENDING}}`; poll
 *   `GET /api/v1/tasks/{task_id}` (id queryable 24 h; the guide: query
 *   every 3–5 s) until `SUCCEEDED` (→ `output.choices[].message.
 *   content[].image`) or a terminal failure. The poll loop lives inside
 *   the 3-minute cloud budget (its own 150 s cap, then a typed error).
 * - Body: `{model, input: {messages: [{role: "user", content: [{text}]}]},
 *   parameters: {}}` on both paths. Per-model parameters:
 *   - `size` `"W*H"` (ASTERISK separator — DashScope's own format, distinct
 *     from the OpenAI-images "WxH") on all three when a complete W×H is
 *     set; wan also documents 1K/2K/4K tier tokens (no v1 seam — the
 *     explicit pixel form always rides);
 *   - `negative_prompt` — qwen-image ONLY (the wan2.7 API reference
 *     REJECTS it; z-image documents none): sent for qwen models, DROPPED
 *     for wan/z (the card's fold-into-prompt is a prompt rewrite the user
 *     did not ask for — dropping is the honest no-op);
 *   - `seed` [0, 2147483647] — z-image ONLY on its t2i surface (the card
 *     documents qwen's seed on the EDIT path): sent for z-image, dropped
 *     otherwise;
 *   - `watermark: false` for wan — the t2i guide's own example value (the
 *     same watermark-off named decision as Volcengine; qwen/z-image t2i
 *     examples carry no watermark param → not sent there);
 *   - `prompt_extend` NEVER sent (no VT seam; the per-model VENDOR defaults
 *     stand — true on qwen, false on z-image, documented, not ours);
 *     thinking_mode / enable_sequential / n / color_palette: no seams.
 * - Response (sync and completed task alike):
 *   `output.choices[].message.content[]` entries — `{image: URL}` (PNG,
 *   valid 24 h → downloaded server-side, the cloud-URL-expiry rule) and
 *   `{text}` (echo/rewritten prompt — ignored). `usage.width/height`
 *   (z-image) and `usage.size` `"2976*1408"` (wan) report the actual
 *   output size → parsed onto the generate result when present.
 * - No image-model list endpoint (the guide lists models in prose) →
 *   STATIC trio catalog. Probe: invalid-post creds discrimination on the
 *   SYNC endpoint ({} — live-probed 401 without a key; with a key it is a
 *   validation 4xx; an empty body can never generate).
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
import {
  normalizeOpenAiCompatibleBaseUrl,
  buildHeaders,
} from "../../providers/provider-transport.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class DashscopeImageError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response. */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "DashscopeImageError";
    this.status = options?.status;
  }
}

export class DashscopeImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashscopeImageConfigError";
  }
}

// ─── Documented surface ──────────────────────────────────────────────────────

/** Sync-path model families (the API references' own routing): qwen-image*
 *  and z-image* answer the multimodal-generation endpoint; everything wan*
 *  rides the async image-generation endpoint. */
function isWanModel(model: string): boolean {
  return model.startsWith("wan");
}

/** The static trio — the t2i guide's documented flagship lineup (no
 *  image-model list endpoint exists). */
const STATIC_MODELS: readonly ImageGenModelInfo[] = [
  { id: "qwen-image-3.0-pro", label: "Qwen Image 3.0 Pro" },
  { id: "wan2.7-image-pro", label: "Wan2.7 Image Pro" },
  { id: "z-image-turbo", label: "Z-Image Turbo" },
];

const SYNC_GENERATION_PATH = "/services/aigc/multimodal-generation/generation";
const ASYNC_GENERATION_PATH = "/services/aigc/image-generation/generation";

/** Poll cadence per the t2i guide ("every 3 to 5 s"): start at 3 s, double
 *  every 30 s of elapsed time (the card's back-off note), cap at 15 s. */
const POLL_INITIAL_INTERVAL_MS = 3_000;
const POLL_INTERVAL_CAP_MS = 15_000;
const POLL_BACKOFF_WINDOW_MS = 30_000;
/** The poll budget — inside the 3-minute cloud generation timeout. */
const POLL_TOTAL_BUDGET_MS = 150_000;

/** Real production wait (the test seam overrides this via the helper's
 *  `wait` parameter — no sleeps in tests). */
const realWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Config ──────────────────────────────────────────────────────────────────

interface DashscopeImageConfig {
  endpoint: string;
  apiKey: string;
  model: string | undefined;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): DashscopeImageConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  // Paste tolerance: a full sync-path URL keeps working.
  if (endpoint.endsWith(SYNC_GENERATION_PATH)) {
    endpoint = endpoint.slice(0, -SYNC_GENERATION_PATH.length);
  } else if (endpoint.endsWith(ASYNC_GENERATION_PATH)) {
    endpoint = endpoint.slice(0, -ASYNC_GENERATION_PATH.length);
  }
  if (!endpoint) {
    throw new DashscopeImageConfigError("DashScope config error: `endpoint` is required");
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new DashscopeImageConfigError(
      "DashScope config error: `apiKey` is required (the card has no keyless surface)",
    );
  }
  const model = config.model !== undefined && config.model.trim() !== "" ? config.model : undefined;
  return { endpoint, apiKey, model, fetch: config.fetch ?? fetch };
}

// ─── HTTP + parsing helpers ──────────────────────────────────────────────────

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
    throw new DashscopeImageError(
      `DashScope ${operation} network error: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

/** Read the `output` object from a 2xx DashScope body, failing closed on
 *  the documented error convention (`code` + `message` at the root for
 *  failed requests, `output.code`/`output.message` for failed subtasks). */
function readOutput(payload: unknown, operation: string): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) {
    throw new DashscopeImageError(`DashScope ${operation} returned a non-object payload`);
  }
  const root = payload as Record<string, unknown>;
  const rootCode = root.code;
  if (typeof rootCode === "string" && rootCode.length > 0) {
    throw new DashscopeImageError(
      `DashScope ${operation} failed with code ${rootCode}: ${
        typeof root.message === "string" ? root.message : "(no message)"
      }`,
    );
  }
  const output = root.output;
  if (typeof output !== "object" || output === null) {
    throw new DashscopeImageError(`DashScope ${operation} response is missing \`output\``);
  }
  return output as Record<string, unknown>;
}

/** Collect the 24-hour image URLs from `output.choices[].message.
 *  content[].image` (the shape BOTH the sync response and a SUCCEEDED task
 *  carry — verified against the live API reference examples). */
function collectImageUrls(output: Record<string, unknown>, operation: string): string[] {
  const choices = output.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new DashscopeImageError(`DashScope ${operation} output carried no choices`);
  }
  const urls: string[] = [];
  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;
    const message = (choice as Record<string, unknown>).message;
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const entry of content) {
      if (typeof entry !== "object" || entry === null) continue;
      const image = (entry as Record<string, unknown>).image;
      if (typeof image === "string" && image.length > 0) urls.push(image);
    }
  }
  if (urls.length === 0) {
    throw new DashscopeImageError(`DashScope ${operation} output carried no images`);
  }
  return urls;
}

/** Parse DashScope's `"W*H"` usage size onto the result when present. */
function parseUsageSize(usage: unknown): { width: number; height: number } | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const record = usage as Record<string, unknown>;
  if (typeof record.width === "number" && typeof record.height === "number") {
    return { width: record.width, height: record.height };
  }
  if (typeof record.size === "string") {
    const match = /^(\d+)\*(\d+)$/.exec(record.size);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  }
  return undefined;
}

/** Poll an async DashScope task until it completes; resolves with the
 *  COMPLETED task response root (carrying both `output` and `usage`).
 *  Exported as the test seam: `wait` defaults to the real sleep; tests
 *  inject an instant resolver and a scripted fetch (no sleeps in tests —
 *  hygiene R5). */
export async function pollDashScopeTask(params: {
  endpoint: string;
  apiKey: string;
  taskId: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
  wait?: (ms: number) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const wait = params.wait ?? realWait;
  let elapsed = 0;
  for (;;) {
    const response = await fetchOrWrap(
      params.fetch,
      `${params.endpoint}/tasks/${params.taskId}`,
      { method: "GET", headers: buildHeaders(params.apiKey), signal: params.signal },
      "task poll",
    );
    if (!response.ok) {
      const excerpt = await readProviderErrorBody(response);
      throw new DashscopeImageError(
        `DashScope task poll failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
        { status: response.status },
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    if (typeof payload !== "object" || payload === null) {
      throw new DashscopeImageError("DashScope task poll returned a non-object payload");
    }
    const root = payload as Record<string, unknown>;
    const output = readOutput(root, "task poll");
    const status = output.task_status;
    if (status === "SUCCEEDED") return root;
    if (status === "PENDING" || status === "RUNNING") {
      if (elapsed >= POLL_TOTAL_BUDGET_MS) {
        throw new DashscopeImageError(
          `DashScope task ${params.taskId} did not complete within ${
            POLL_TOTAL_BUDGET_MS / 1000
          }s (last status: ${String(status)})`,
        );
      }
      // 3–5 s cadence (guide), doubling every 30 s of elapsed time, capped.
      const interval = Math.min(
        POLL_INITIAL_INTERVAL_MS * 2 ** Math.floor(elapsed / POLL_BACKOFF_WINDOW_MS),
        POLL_INTERVAL_CAP_MS,
      );
      await wait(interval);
      elapsed += interval;
      continue;
    }
    // FAILED / CANCELED / UNKNOWN — terminal, carry the documented
    // output.code/output.message when present.
    const code = output.code;
    const message = output.message;
    const codePart =
      typeof code === "string" && code.length > 0
        ? ` (code ${code}${typeof message === "string" ? `: ${message}` : ""})`
        : "";
    throw new DashscopeImageError(
      `DashScope task ${params.taskId} ended with status ${String(status)}${codePart}`,
    );
  }
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const dashscopeImageFactory = (config: ImageGenAdapterConfig): ImageGenBackend => {
  const cfg = parseConfig(config);

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const model = request.model?.trim() || cfg.model;
      if (!model) {
        throw new DashscopeImageConfigError(
          "DashScope config error: `model` is required (the static trio is qwen-image-3.0-pro, wan2.7-image-pro, z-image-turbo)",
        );
      }
      const wan = isWanModel(model);

      const parameters: Record<string, unknown> = {};
      if (request.width !== undefined && request.height !== undefined) {
        // DashScope's own size format — ASTERISK separator, not "WxH".
        parameters.size = `${request.width}*${request.height}`;
      }
      if (
        model.startsWith("qwen-image") &&
        request.negativePrompt !== undefined &&
        request.negativePrompt !== ""
      ) {
        // qwen-image surface only — the wan2.7 API reference REJECTS the
        // field and z-image documents none: dropped there (never folded
        // into the prompt — that rewrite was not asked for).
        parameters.negative_prompt = request.negativePrompt;
      }
      if (model.startsWith("z-image") && request.seed !== undefined) {
        // z-image t2i documents seed [0, 2147483647]; qwen documents seed
        // on the EDIT path only; wan has none.
        parameters.seed = request.seed;
      }
      if (wan) {
        // The t2i guide's own wan example value — the watermark-off named
        // decision (same as Volcengine; qwen/z-image examples carry none).
        parameters.watermark = false;
      }

      const body: Record<string, unknown> = {
        model,
        input: {
          messages: [{ role: "user", content: [{ text: request.prompt }] }],
        },
        parameters,
      };

      const submitResponse = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}${wan ? ASYNC_GENERATION_PATH : SYNC_GENERATION_PATH}`,
        {
          method: "POST",
          headers: wan
            ? { ...buildHeaders(cfg.apiKey, true), "X-DashScope-Async": "enable" }
            : buildHeaders(cfg.apiKey, true),
          body: JSON.stringify(body),
          signal: request.signal,
        },
        "generation",
      );
      if (!submitResponse.ok) {
        const excerpt = await readProviderErrorBody(submitResponse);
        throw new DashscopeImageError(
          `DashScope generation failed with HTTP ${submitResponse.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: submitResponse.status },
        );
      }
      const submitPayload: unknown = await submitResponse.json().catch(() => null);
      if (typeof submitPayload !== "object" || submitPayload === null) {
        throw new DashscopeImageError("DashScope generation returned a non-object payload");
      }
      const submitRoot = submitPayload as Record<string, unknown>;

      let taskRoot: Record<string, unknown>;
      if (wan) {
        const submitOutput = readOutput(submitRoot, "generation");
        const taskId = submitOutput.task_id;
        if (typeof taskId !== "string" || taskId.length === 0) {
          throw new DashscopeImageError("DashScope async submit response is missing output.task_id");
        }
        taskRoot = await pollDashScopeTask({
          endpoint: cfg.endpoint,
          apiKey: cfg.apiKey,
          taskId,
          fetch: cfg.fetch,
          signal: request.signal,
        });
      } else {
        taskRoot = submitRoot;
      }
      const output = readOutput(taskRoot, "generation");
      const usage = taskRoot.usage;

      const urls = collectImageUrls(output, "generation");
      const images: ImageGenGeneratedImage[] = [];
      for (const url of urls) {
        // 24-hour OSS URL — downloaded server-side, the cloud-URL-expiry
        // rule (adapters never hand remote URLs upward).
        const download = await fetchOrWrap(
          cfg.fetch,
          url,
          { method: "GET", signal: request.signal },
          "image download",
        );
        if (!download.ok) {
          throw new DashscopeImageError(
            `DashScope image download failed with HTTP ${download.status}`,
            { status: download.status },
          );
        }
        images.push({
          data: Buffer.from(await download.arrayBuffer()),
          // The API references document PNG delivery; content-type backs it
          // up when present.
          mimeType: download.headers.get("content-type") ?? "image/png",
        });
      }

      const result: ImageGenGenerateResult = { images };
      const size = parseUsageSize(usage);
      if (size !== undefined) {
        result.width = size.width;
        result.height = size.height;
      }
      return result;
    },

    async listModels(): Promise<ImageGenModelInfo[]> {
      // Static trio — the guide lists image models in prose; no image-model
      // list endpoint exists (the OpenAI-compat list endpoint serves chat).
      return STATIC_MODELS.map((m) => ({ ...m }));
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      // invalid-post creds discrimination on the SYNC endpoint: an empty
      // body (no model, no prompt) can never generate — 401/403 = bad key,
      // 404 = wrong endpoint, any other 4xx = validation reached (auth
      // passed). Live-probed: no key → 401.
      try {
        const response = await cfg.fetch(`${cfg.endpoint}${SYNC_GENERATION_PATH}`, {
          method: "POST",
          headers: buildHeaders(cfg.apiKey, true),
          body: JSON.stringify({}),
          signal,
        });
        if (response.status === 401 || response.status === 403) {
          const excerpt = await readProviderErrorBody(response);
          return {
            ok: false,
            detail: `${response.status}${excerpt ? `: ${excerpt}` : ""} — credentials rejected`,
            status: response.status,
          };
        }
        if (response.status === 404) {
          return { ok: false, detail: "404: generation endpoint not found", status: 404 };
        }
        if (response.status >= 500) {
          const excerpt = await readProviderErrorBody(response);
          return {
            ok: false,
            detail: `${response.status}${excerpt ? `: ${excerpt}` : ""}`,
            status: response.status,
          };
        }
        return { ok: true, detail: `credentials accepted — 3 static models` };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    },

    async dispose(): Promise<void> {
      // Stateless — nothing to release.
    },
  };

  return backend;
};

// Module-scope registration (protocol-registry pattern, the STT/TTS twins).
registerImageGenBackend(IMAGE_GEN_BACKENDS.Dashscope, dashscopeImageFactory);
