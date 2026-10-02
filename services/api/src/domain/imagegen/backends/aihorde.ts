/**
 * @module imagegen/backends/aihorde
 *
 * AI Horde image backend (IMAGEGEN_PROVIDER_EXPANSION_PLAN wave PE-4
 * unit 5) — the crowdsourced free cluster. The wave's first ASYNC arm:
 * submit → poll the light check → fetch the full status. Anonymous use
 * is a first-class tier (the documented `0000000000` key), making this
 * the roster's second keyless backend next to pollinations.
 *
 * Wire facts (card IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH "AI Horde",
 * doc-verified 2026-09-07 from the live swagger; re-verified live
 * 2026-09-18 — swagger.json re-pulled and fully resolved through the
 * allOf chains, heartbeat OK v5.1.11, models endpoint live):
 * - `POST {base}/v2/generate/async` (header `apikey`, body
 *   GenerationInputStable, `prompt` required) → 202 `{id, kudos}`;
 *   poll `GET /v2/generate/check/{id}` (light: done/is_possible/
 *   faulted/wait_time); done → `GET /v2/generate/status/{id}` →
 *   `{generations: [{img, seed, censored}], shared}`;
 *   `DELETE …/status/{id}` cancels. Etiquette: a `Client-Agent` header
 *   is expected — VT sends one.
 * - Params (ModelGenerationInputStable, resolved through the allOf
 *   chain — **DRIFT pinned live 2026-09-18: the sampler enum is now 41
 *   values, not the card's 43**): `steps` 1–500 def 30, `cfg_scale`
 *   0–100 def 7.5, `width`/`height` 64–3072 **multipleOf 64** (VT snaps
 *   to the nearest 64 — a documented schema constraint, not an
 *   invention), `seed` as a STRING (text is allowed), `sampler_name`
 *   41-value enum (static listSamplers), `scheduler` 11-value enum —
 *   the A1111-dialect scheduler seam's first CLOUD landing (both
 *   request.scheduler and listSamplers/schedulers ride this arm).
 * - Negative prompt: NOT a schema field — the horde-native ` ### `
 *   separator convention (SillyTavern's own PR cites `pos ### neg` as
 *   "the well-known syntax used by Stable Horde"; guides-documented,
 *   swagger-silent — the card's verify-at-adapter-time note CLOSED).
 * - Request-level flags VT sets explicitly: `r2: true` (Cloudflare R2
 *   download URL instead of inline b64 — the server-side download
 *   either way) and `shared: false` (never contribute the user's
 *   prompts to LAION — privacy, the flag's default is false but VT
 *   pins it). `nsfw`/`censor_nsfw`/worker selection have no VT seam —
 *   never sent.
 * - Model listing: `GET /v2/status/models?type=image` — live (164
 *   models 2026-09-18; per-model workers/queue/eta). Anonymous works.
 * - Probe (live-probed 2026-09-18): `dry_run: true` submit — the
 *   documented free "estimate" (returns the kudos cost, generates
 *   nothing): anonymous key → 200 `{"kudos": 10}`; invalid registered
 *   key → 401 "No user matching sent API Key".
 * - Response generations[0]: `img` (base64 webp, or the R2 URL with
 *   r2:true — https-prefixed entries download server-side, everything
 *   else decodes), `seed` (string), `censored` (true = the worker's
 *   safety filter blanked it → typed error).
 * - UX caveat (surfaced to the owner, NOT silently worked around):
 *   crowdsourced queues can run MINUTES anonymous — the shared 3-minute
 *   cloud timeout can cut a slow queue off; the poll forwards the
 *   caller's abort and best-effort-cancels the horde request on the way
 *  out.
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
  ImageGenSamplerInfo,
} from "../imagegen-backend.js";
import { registerImageGenBackend } from "../imagegen-registry.js";
import { normalizeOpenAiCompatibleBaseUrl } from "../../providers/provider-transport.js";
import { readProviderErrorBody } from "../../../infrastructure/ai/provider-error-body.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class HordeImageError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response. */
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = "HordeImageError";
    this.status = options?.status;
  }
}

export class HordeImageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HordeImageConfigError";
  }
}

// ─── Documented surface (live swagger 2026-09-18) ───────────────────────────

/** The documented anonymous key (a first-class tier, not a bypass). */
export const HORDE_ANONYMOUS_API_KEY = "0000000000";

/** The sampler_name enum — 41 values, live-pinned 2026-09-18 (the card's
 *  43-value list drifted; the CURRENT swagger enum verbatim,
 *  alphabetized). */
const HORDE_SAMPLERS: readonly string[] = [
  "DDIM", "ddpm", "deis", "dpmpp_2m_cfg_pp",
  "dpmpp_2m_sde", "dpmpp_2m_sde_heun", "dpmpp_2s_ancestral_cfg_pp", "dpmpp_3m_sde",
  "dpmsolver", "er_sde", "euler_ancestral_cfg_pp", "euler_cfg_pp",
  "exp_heun_2_x0", "exp_heun_2_x0_sde", "gradient_estimation", "gradient_estimation_cfg_pp",
  "heunpp2", "ipndm", "ipndm_v", "k_dpm_2",
  "k_dpm_2_a", "k_dpm_adaptive", "k_dpm_fast", "k_dpmpp_2m",
  "k_dpmpp_2s_a", "k_dpmpp_sde", "k_euler", "k_euler_a",
  "k_heun", "k_lms", "lcm", "res_multistep",
  "res_multistep_ancestral", "res_multistep_ancestral_cfg_pp", "res_multistep_cfg_pp", "sa_solver",
  "sa_solver_pece", "seeds_2", "seeds_3", "uni_pc",
  "uni_pc_bh2",
];

/** Snap a dimension onto the documented 64-multiple grid [64, 3072]. */
export function snapHordeDimension(value: number): number {
  const snapped = Math.round(value / 64) * 64;
  return Math.min(3072, Math.max(64, snapped));
}

/** The Client-Agent etiquette header (docs: expected on every call). */
const CLIENT_AGENT = "VibeTavern:1.0:https://github.com/local/vibe-tavern";

// ─── Config ──────────────────────────────────────────────────────────────────

interface HordeImageConfig {
  endpoint: string;
  apiKey: string;
  model: string | undefined;
  fetch: typeof fetch;
}

function parseConfig(config: ImageGenAdapterConfig): HordeImageConfig {
  let endpoint = normalizeOpenAiCompatibleBaseUrl(config.endpoint ?? "");
  // Paste tolerance: v2-prefixed pastes normalize to the bare base.
  for (const suffix of ["/v2/generate/async", "/v2/generate", "/v2"]) {
    if (endpoint.endsWith(suffix)) {
      endpoint = endpoint.slice(0, -suffix.length);
      break;
    }
  }
  if (!endpoint) {
    throw new HordeImageConfigError("AI Horde config error: `endpoint` is required");
  }
  // Anonymous is a first-class tier — no key is not a config error.
  const apiKey = config.apiKey?.trim() || HORDE_ANONYMOUS_API_KEY;
  const model = config.model !== undefined && config.model.trim() !== "" ? config.model : undefined;
  return { endpoint, apiKey, model, fetch: config.fetch ?? fetch };
}

// ─── HTTP + response parsing ─────────────────────────────────────────────────

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
    throw new HordeImageError(
      `AI Horde ${operation} network error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

function hordeHeaders(apiKey: string, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: apiKey,
    "Client-Agent": CLIENT_AGENT,
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

/** MIME sniffing (the family helper's logic, local twin). */
function sniffImageMime(bytes: Buffer): string | null {
  if (
    bytes.length >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
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
  return null;
}

interface HordeWaitControl {
  wait: (ms: number) => Promise<void>;
}

/** The default wait — a real sleep (the seam exists so tests inject a
 *  no-op and the poll loop never stalls). */
const defaultWaitControl: HordeWaitControl = {
  wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/** Poll the light check endpoint until done (or faulted / impossible).
 *  Cadence: 3 s doubling to a 15 s cap (the dashscope precedent).
 *  Exported as the test seam — inject `wait` to run instantly. */
export async function pollHordeGeneration(
  transport: typeof fetch,
  endpoint: string,
  id: string,
  signal: AbortSignal | undefined,
  control: HordeWaitControl = defaultWaitControl,
): Promise<void> {
  let delay = 3000;
  for (;;) {
    const check = await fetchOrWrap(
      transport,
      `${endpoint}/v2/generate/check/${id}`,
      { method: "GET", headers: hordeHeaders(HORDE_ANONYMOUS_API_KEY, false), signal },
      "status check",
    );
    if (!check.ok) {
      const excerpt = await readProviderErrorBody(check);
      throw new HordeImageError(
        `AI Horde status check failed with HTTP ${check.status}${excerpt ? `: ${excerpt}` : ""}`,
        { status: check.status },
      );
    }
    const payload = (await check.json()) as Record<string, unknown>;
    if (payload.faulted === true) {
      throw new HordeImageError("AI Horde request faulted (workers failed or timed out)");
    }
    if (payload.is_possible === false) {
      throw new HordeImageError(
        "AI Horde cannot serve this request (no worker can run the chosen model/size)",
      );
    }
    if (payload.done === true) return;
    await control.wait(delay);
    delay = Math.min(15000, delay * 2);
  }
}

/** Best-effort cancellation — returns an outcome instead of throwing, so
 *  the original error/abort is never masked. */
async function cancelHordeRequest(
  transport: typeof fetch,
  endpoint: string,
  id: string,
): Promise<void> {
  await fetchOrWrap(transport, `${endpoint}/v2/generate/status/${id}`, {
    method: "DELETE",
    headers: hordeHeaders(HORDE_ANONYMOUS_API_KEY, false),
  }, "cancel").catch(() => undefined);
}

// ─── Registration ────────────────────────────────────────────────────────────

registerImageGenBackend(
  IMAGE_GEN_BACKENDS.Aihorde,
  (config: ImageGenAdapterConfig): ImageGenBackend => {
    const parsed = parseConfig(config);

    function buildBody(request: ImageGenGenerateRequest, model: string | undefined): string {
      // The horde-native negative convention: `pos ### neg` (guides-
      // documented, swagger-silent — see module doc).
      const prompt =
        request.negativePrompt !== undefined && request.negativePrompt !== ""
          ? `${request.prompt} ### ${request.negativePrompt}`
          : request.prompt;
      const body: Record<string, unknown> = {
        prompt,
        // R2 download URL (server-side download either way) + never
        // contribute the user's prompts to LAION.
        r2: true,
        shared: false,
      };
      const params: Record<string, unknown> = {};
      if (request.width !== undefined) params.width = snapHordeDimension(request.width);
      if (request.height !== undefined) params.height = snapHordeDimension(request.height);
      if (request.steps !== undefined) params.steps = request.steps;
      if (request.cfgScale !== undefined) params.cfg_scale = request.cfgScale;
      if (request.seed !== undefined) params.seed = String(request.seed); // string wire
      if (request.sampler !== undefined && request.sampler !== "") {
        params.sampler_name = request.sampler;
      }
      if (request.scheduler !== undefined && request.scheduler !== "") {
        params.scheduler = request.scheduler;
      }
      if (Object.keys(params).length > 0) body.params = params;
      if (model !== undefined) body.models = [model];
      // nsfw / censor_nsfw / worker selection: no VT seam — never sent.
      return JSON.stringify(body);
    }

    return {
      async generate(request: ImageGenGenerateRequest): Promise<ImageGenGenerateResult> {
        const model = request.model?.trim() || parsed.model;
        const submit = await fetchOrWrap(
          parsed.fetch,
          `${parsed.endpoint}/v2/generate/async`,
          {
            method: "POST",
            headers: hordeHeaders(parsed.apiKey, true),
            body: buildBody(request, model),
            signal: request.signal,
          },
          "generation submit",
        );
        if (!submit.ok) {
          const excerpt = await readProviderErrorBody(submit);
          throw new HordeImageError(
            `AI Horde submit failed with HTTP ${submit.status}${excerpt ? `: ${excerpt}` : ""}`,
            { status: submit.status },
          );
        }
        const submitted = (await submit.json()) as Record<string, unknown>;
        const id = submitted.id;
        if (typeof id !== "string" || id.length === 0) {
          throw new HordeImageError("AI Horde submit returned no request id");
        }
        try {
          await pollHordeGeneration(parsed.fetch, parsed.endpoint, id, request.signal);
        } catch (error) {
          // Best-effort cancel on ANY poll failure, then surface.
          await cancelHordeRequest(parsed.fetch, parsed.endpoint, id);
          throw error;
        }
        const status = await fetchOrWrap(
          parsed.fetch,
          `${parsed.endpoint}/v2/generate/status/${id}`,
          { method: "GET", headers: hordeHeaders(parsed.apiKey, false), signal: request.signal },
          "status fetch",
        );
        if (!status.ok) {
          const excerpt = await readProviderErrorBody(status);
          throw new HordeImageError(
            `AI Horde status fetch failed with HTTP ${status.status}${excerpt ? `: ${excerpt}` : ""}`,
            { status: status.status },
          );
        }
        const payload = (await status.json()) as Record<string, unknown>;
        const generations = payload.generations;
        if (!Array.isArray(generations) || generations.length === 0 || typeof generations[0] !== "object") {
          throw new HordeImageError("AI Horde completed with no generations");
        }
        const generation = generations[0] as Record<string, unknown>;
        if (generation.censored === true) {
          throw new HordeImageError("AI Horde censored this generation (the worker's safety filter)");
        }
        const img = generation.img;
        if (typeof img !== "string" || img.length === 0) {
          throw new HordeImageError("AI Horde generation carries no image");
        }
        let bytes: Buffer;
        if (/^https?:\/\//i.test(img)) {
          const download = await fetchOrWrap(
            parsed.fetch,
            img,
            { method: "GET", signal: request.signal },
            "image download",
          );
          if (!download.ok) {
            throw new HordeImageError(
              `AI Horde image download failed with HTTP ${download.status}`,
              { status: download.status },
            );
          }
          bytes = Buffer.from(await download.arrayBuffer());
        } else {
          bytes = Buffer.from(img, "base64");
        }
        const image: ImageGenGeneratedImage = {
          data: bytes,
          mimeType: sniffImageMime(bytes) ?? "image/webp",
        };
        const result: ImageGenGenerateResult = { images: [image] };
        if (typeof generation.seed === "string" && /^-?\d+$/.test(generation.seed)) {
          result.seed = Number.parseInt(generation.seed, 10);
        }
        return result;
      },

      async listModels(signal?: AbortSignal): Promise<ImageGenModelInfo[]> {
        const response = await fetchOrWrap(
          parsed.fetch,
          `${parsed.endpoint}/v2/status/models?type=image`,
          { method: "GET", headers: hordeHeaders(parsed.apiKey, false), signal },
          "model listing",
        );
        if (!response.ok) {
          throw new HordeImageError(
            `AI Horde model listing failed with HTTP ${response.status}`,
            { status: response.status },
          );
        }
        const payload: unknown = await response.json();
        if (!Array.isArray(payload)) {
          throw new HordeImageError("AI Horde model listing: expected a JSON array");
        }
        return payload.flatMap((entry): ImageGenModelInfo[] => {
          if (typeof entry !== "object" || entry === null) return [];
          const name = (entry as Record<string, unknown>).name;
          if (typeof name !== "string" || name.length === 0) return [];
          return [{ id: name, label: name }];
        });
      },

      async listSamplers(): Promise<ImageGenSamplerInfo[]> {
        return HORDE_SAMPLERS.map((name) => ({ name }));
      },

      async probe(signal?: AbortSignal): Promise<ImageGenProbeResult> {
        // The documented dry_run estimate (live-probed 2026-09-18):
        // anonymous → 200 {kudos}; invalid registered key → 401.
        try {
          const response = await parsed.fetch(`${parsed.endpoint}/v2/generate/async`, {
            method: "POST",
            headers: hordeHeaders(parsed.apiKey, true),
            body: JSON.stringify({ prompt: "probe", dry_run: true }),
            signal,
          });
          if (response.ok) {
            const tier = parsed.apiKey === HORDE_ANONYMOUS_API_KEY ? "anonymous tier" : "registered key";
            return { ok: true, detail: `reachable — ${tier} accepted (dry-run estimate)` };
          }
          if (response.status === 401 || response.status === 403) {
            const excerpt = await readProviderErrorBody(response);
            return {
              ok: false,
              detail: `${response.status}${excerpt ? `: ${excerpt}` : ""} — API key rejected`,
              status: response.status,
            };
          }
          if (response.status === 429) {
            return { ok: true, detail: "reachable — rate limited (try again shortly)", status: 429 };
          }
          if (response.status >= 500) {
            return { ok: false, detail: `HTTP ${response.status}`, status: response.status };
          }
          return { ok: true, detail: `reachable — HTTP ${response.status}` };
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          return { ok: false, detail: error instanceof Error ? error.message : String(error) };
        }
      },

      async dispose(): Promise<void> {
        // No persistent resources — the arm is request-scoped.
      },
    };
  },
);
