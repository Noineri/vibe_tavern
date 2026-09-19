/**
 * @module imagegen/backends/luma
 *
 * Luma Agents API image backend (IMAGEGEN_PROVIDER_EXPANSION_PLAN wave
 * PE-5 unit 5) — the NEW generation surface: submit to
 * `POST https://agents.lumalabs.ai/v1/generations`, poll
 * `GET /v1/generations/{id}`, download the presigned output URL.
 *
 * Wire facts (card IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "Luma", doc-verified
 * 2026-09-07; re-verified live 2026-09-18: the image-generation guide
 * fetched in full from its `.md` twin + no-key probes on both endpoints):
 *
 * - Transport: Bearer auth. Submit body `{prompt, model?, aspect_ratio?,
 *   …}` — documented defaults `model: "uni-1"`, `type: "image"`,
 *   `style: "auto"`; `aspect_ratio`/`output_format` unset = the model
 *   picks. VT sends ONLY what the user set: prompt always; `model` when
 *   a non-default is selected (uni-1 default stands unsent); type/style/
 *   output_format/web_search/image_ref never sent (no VT seam; vendor
 *   defaults — the params-unset discipline).
 * - `aspect_ratio`: the documented 9-value grid (3:1 … 1:3) — VT's W×H
 *   maps onto it exact-else-nearest (the replicate precedent; the
 *   vendor's size control IS the ratio). **The manga portrait-only
 *   trap** (style manga permits only 2:3/9:16/1:2/1:3 — landscape or
 *   square is HTTP 422): VT never sends `style` in v1, so the trap
 *   cannot fire on our wire; documented in the caps row for the day a
 *   style seam appears.
 * - Response: submit → `{id, state: "queued", model, output: [],
 *   failure_reason, failure_code}`; poll `GET /v1/generations/{id}`
 *   until `completed` (output = presigned download URLs) or `failed`
 *   (carry failure_reason/failure_code). Non-terminal: queued,
 *   processing. NO seed/steps/negative on the surface (per-card) — the
 *   seed capability is OFF (the wave's first seed-less arm).
 * - Output: `output[]` entries `{type: "image", url}` — presigned
 *   (X-Amz-Expires query auth) → downloaded server-side keyless, first
 *   entry wins (VT generates one). No cancel endpoint exists on the
 *   surface (sitemap-verified: create/get only) — nothing to
 *   best-effort-cancel (the dashscope precedent).
 * - Model catalog: static duo {uni-1, uni-1-max} — no list endpoint
 *   exists (per-card; sitemap re-verified).
 * - Poll cadence: 1 s → doubling per 30 s → 5 s cap; total budget 150 s
 *   inside the 3-minute cloud timeout. Live no-key ladder: 401
 *   `{"detail":"Missing or invalid API key"}` on both endpoints.
 */

import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import type {
  ImageGenAdapterConfig,
  ImageGenBackend,
  ImageGenGenerateRequest,
  ImageGenGenerateResult,
  ImageGenGeneratedImage,
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

export class LumaImageError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response. */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "LumaImageError";
    this.status = options?.status;
  }
}

export class LumaImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LumaImageConfigError";
  }
}

// ─── Documented surface ──────────────────────────────────────────────────────

/** The documented default — sent only when the user overrides it. */
export const LUMA_DEFAULT_MODEL = "uni-1";

/** The documented aspect_ratio grid (the image-generation guide table). */
export const LUMA_ASPECT_RATIOS = [
  "3:1", "2:1", "16:9", "3:2", "1:1", "2:3", "9:16", "1:2", "1:3",
] as const;

/** Exact W:H reduction first, else the nearest ratio by log distance
 *  (the replicate precedent). */
export function mapLumaAspectRatio(width?: number, height?: number): string | undefined {
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  const reduced = `${width / divisor}:${height / divisor}`;
  if ((LUMA_ASPECT_RATIOS as readonly string[]).includes(reduced)) return reduced;
  const target = Math.log(width / height);
  let best: string = LUMA_ASPECT_RATIOS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ratio of LUMA_ASPECT_RATIOS) {
    const [w, h] = ratio.split(":").map(Number) as [number, number];
    const distance = Math.abs(Math.log(w / h) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = ratio;
    }
  }
  return best;
}

/** Statuses that keep polling (the guide's states table). */
const NON_TERMINAL_STATES = new Set(["queued", "processing"]);

/** The static duo — no list endpoint exists on the surface. */
const STATIC_MODELS: readonly ImageGenModelInfo[] = [
  { id: "uni-1", label: "uni-1 (default)" },
  { id: "uni-1-max", label: "uni-1-max (higher quality)" },
];

/** Poll cadence: 1 s → doubling per 30 s → 5 s cap (the bfl/fal shape). */
const POLL_INITIAL_INTERVAL_MS = 1_000;
const POLL_INTERVAL_CAP_MS = 5_000;
const POLL_BACKOFF_WINDOW_MS = 30_000;
/** The poll budget — inside the 3-minute cloud generation timeout. */
const POLL_TOTAL_BUDGET_MS = 150_000;

/** Real production wait (the test seam overrides this — no sleeps in
 *  tests). */
const realWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Config ──────────────────────────────────────────────────────────────────

interface LumaImageConfig {
  endpoint: string;
  apiKey: string;
  model: string | undefined;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): LumaImageConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  // Paste tolerance: a /v1-suffixed base keeps working.
  if (endpoint.endsWith("/v1")) {
    endpoint = endpoint.slice(0, -"/v1".length);
  }
  if (!endpoint) {
    throw new LumaImageConfigError("Luma config error: `endpoint` is required");
  }
  const apiKey = config.apiKey?.trim() ?? "";
  if (!apiKey) {
    throw new LumaImageConfigError("Luma config error: `apiKey` is required (the Bearer key)");
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
    throw new LumaImageError(
      `Luma ${operation} network error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/** Poll a Luma generation until completed; resolves with the COMPLETED
 *  payload root. Exported as the test seam: `wait` defaults to the real
 *  sleep; tests inject an instant resolver and a scripted fetch (no
 *  sleeps in tests — hygiene R5). */
export async function pollLumaGeneration(params: {
  getUrl: string;
  apiKey: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
  wait?: (ms: number) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const wait = params.wait ?? realWait;
  let elapsed = 0;
  for (;;) {
    const response = await fetchOrWrap(
      params.fetch,
      params.getUrl,
      {
        method: "GET",
        headers: buildHeaders(params.apiKey, false),
        signal: params.signal,
      },
      "generation poll",
    );
    if (!response.ok) {
      const excerpt = await readProviderErrorBody(response);
      throw new LumaImageError(
        `Luma generation poll failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
        { status: response.status },
      );
    }
    const payload: unknown = await response.json().catch(() => null);
    if (typeof payload !== "object" || payload === null) {
      throw new LumaImageError("Luma generation poll returned a non-object payload");
    }
    const root = payload as Record<string, unknown>;
    const state = root.state;
    if (state === "completed") return root;
    if (typeof state === "string" && NON_TERMINAL_STATES.has(state)) {
      if (elapsed >= POLL_TOTAL_BUDGET_MS) {
        throw new LumaImageError(
          `Luma generation did not complete within ${POLL_TOTAL_BUDGET_MS / 1000}s (last state: ${state})`,
        );
      }
      const interval = Math.min(
        POLL_INITIAL_INTERVAL_MS * 2 ** Math.floor(elapsed / POLL_BACKOFF_WINDOW_MS),
        POLL_INTERVAL_CAP_MS,
      );
      await wait(interval);
      elapsed += interval;
      continue;
    }
    // failed / unrecognized — terminal, carry failure_reason/code.
    const reason = root.failure_reason;
    const code = root.failure_code;
    const parts: string[] = [String(state)];
    if (typeof code === "string" && code.length > 0) parts.push(`code ${code}`);
    if (typeof reason === "string" && reason.length > 0) parts.push(reason);
    throw new LumaImageError(`Luma generation ended: ${parts.join(" — ")}`);
  }
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const lumaImageFactory = (config: ImageGenAdapterConfig): ImageGenBackend => {
  const cfg = parseConfig(config);

  const backend: ImageGenBackend = {
    async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
      const model = request.model?.trim() || cfg.model || LUMA_DEFAULT_MODEL;

      const body: Record<string, unknown> = { prompt: request.prompt };
      if (model !== LUMA_DEFAULT_MODEL) {
        // The documented default stands unsent; an override rides.
        body.model = model;
      }
      const aspectRatio = mapLumaAspectRatio(request.width, request.height);
      if (aspectRatio !== undefined) {
        body.aspect_ratio = aspectRatio;
      }
      // No seed/steps/negative on the surface — capability off, the wire
      // never carries them. type/style/output_format/web_search/image_ref:
      // vendor defaults — never sent (params-unset discipline).

      const submit = await fetchOrWrap(
        cfg.fetch,
        `${cfg.endpoint}/v1/generations`,
        {
          method: "POST",
          headers: buildHeaders(cfg.apiKey, true),
          body: JSON.stringify(body),
          signal: request.signal,
        },
        "generation",
      );
      if (!submit.ok) {
        const excerpt = await readProviderErrorBody(submit);
        throw new LumaImageError(
          `Luma generation failed with HTTP ${submit.status}${excerpt ? `: ${excerpt}` : ""}`,
          { status: submit.status },
        );
      }
      const submitted: unknown = await submit.json().catch(() => null);
      if (typeof submitted !== "object" || submitted === null) {
        throw new LumaImageError("Luma generation returned a non-object payload");
      }
      const id = (submitted as Record<string, unknown>).id;
      if (typeof id !== "string" || id.length === 0) {
        throw new LumaImageError("Luma submit response is missing `id`");
      }

      const completed = await pollLumaGeneration({
        getUrl: `${cfg.endpoint}/v1/generations/${id}`,
        apiKey: cfg.apiKey,
        fetch: cfg.fetch,
        signal: request.signal,
      });

      const output = completed.output;
      if (!Array.isArray(output) || output.length === 0) {
        throw new LumaImageError("Luma completed generation carried no output");
      }
      const first = output[0];
      const url =
        typeof first === "object" && first !== null
          ? (first as Record<string, unknown>).url
          : undefined;
      if (typeof url !== "string" || url.length === 0) {
        throw new LumaImageError("Luma output entry is missing `url`");
      }

      // Presigned URL (X-Amz-Expires query auth) — self-authorizing,
      // downloaded keyless server-side (the signed-URL rule).
      const download = await fetchOrWrap(
        cfg.fetch,
        url,
        { method: "GET", signal: request.signal },
        "image download",
      );
      if (!download.ok) {
        throw new LumaImageError(`Luma image download failed with HTTP ${download.status}`, {
          status: download.status,
        });
      }

      return {
        images: [
          {
            data: Buffer.from(await download.arrayBuffer()),
            mimeType: download.headers.get("content-type") ?? "image/png",
          },
        ],
      };
    },

    async listModels(): Promise<ImageGenModelInfo[]> {
      // Static duo — no list endpoint exists on the surface.
      return STATIC_MODELS.map((m) => ({ ...m }));
    },

    async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
      // invalid-post creds discrimination on the generations endpoint:
      // an empty body (no prompt — required) can never generate. Live
      // ladder: 401 {"detail":"Missing or invalid API key"} = rejected;
      // any other 4xx = validation reached (auth passed).
      try {
        const response = await cfg.fetch(`${cfg.endpoint}/v1/generations`, {
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
          return { ok: false, detail: "404: generations endpoint not found", status: 404 };
        }
        if (response.status >= 500) {
          const excerpt = await readProviderErrorBody(response);
          return {
            ok: false,
            detail: `${response.status}${excerpt ? `: ${excerpt}` : ""}`,
            status: response.status,
          };
        }
        return { ok: true, detail: "credentials accepted — static duo (uni-1, uni-1-max)" };
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
registerImageGenBackend(IMAGE_GEN_BACKENDS.Luma, lumaImageFactory);
