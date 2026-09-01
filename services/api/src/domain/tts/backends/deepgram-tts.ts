/**
 * Deepgram Aura TTS backend (TPE-10).
 *
 * API facts below were verified 2026-09-02 against developers.deepgram.com
 * (REST reference "Single Text Request", docs tts-models / tts-encoding,
 * reference "List All Available Models" — all live-fetched via llms.txt):
 * - POST https://api.deepgram.com/v1/speak — auth `Authorization: Token
 *   <API_KEY>` (Bearer JWT also accepted), JSON body {"text"}, response
 *   200 = the raw audio stream; the content-type header names the format
 *   (audio/mpeg for the default mp3 encoding — REST default mp3, no need
 *   to send encoding at all).
 * - Query params: model (default `aura-asteria-en` — an aura-1 voice),
 *   encoding (mp3/opus/flac/aac/linear16/mulaw/alaw), sample_rate
 *   (default 24000), bit_rate (default 48000), container (wav — only for
 *   PCM-type encodings), speed (double, default 1, documented range
 *   0.7–1.5, "not yet supported in all languages"), mip_opt_out, tag.
 * - Model == voice: the model id IS the voice id, format
 *   `[family]-[voicename]-[language]` (aura-asteria-en, aura-2-thalia-en).
 * - LIVE catalog: GET /v1/models returns {stt: [...], tts: [...]} where
 *   each tts entry carries name, canonical_name ("aura-2-zeus-en"),
 *   architecture ("aura-2"), languages (["en","en-US"]), metadata
 *   {accent, age, tags, use_cases}. Feeds listVoices() — zero hardcoded
 *   roster (owner rule 2026-09-01): the criterion is the response's own
 *   tts array plus the documented id shape, never a baked voice list.
 * - listModels() is deliberately NOT implemented: model==voice, so the
 *   voice picker is the single selector (SPECS carry no model field).
 * - Empty voiceId → the `model` param is omitted and the DOCUMENTED
 *   server default (aura-asteria-en) applies — unlike backends whose
 *   voiceless requests would 4xx.
 * - Errors: non-2xx with the message text in the body (the docs' curl
 *   examples use --fail-with-body); documented statuses 413 (text over
 *   limit), 422, 429 (rate limit).
 * - No voice cloning anywhere in the TTS product (matrix-confirmed
 *   round-1, re-verified) — capabilities().supportsCloning stays false,
 *   which is what hides the profile editor's clone section.
 */

import { TTS_BACKEND } from "@vibe-tavern/domain";
import type { TtsProfileConfig } from "@vibe-tavern/domain";

import type {
  TtsBackend,
  TtsBackendCapabilities,
  TtsBackendFactory,
  TtsVoiceInfo,
  TtsAudioResult,
  TtsGenerateRequest,
  TtsProbeResult,
} from "../tts-backend.js";
import { registerTtsBackend } from "../tts-registry.js";

const DEEPGRAM_BASE_URL = "https://api.deepgram.com";

/** speed — documented range 0.7..1.5 (double), default 1. */
const MIN_SPEED = 0.7;
const MAX_SPEED = 1.5;

/** Fallback mime when the response carries no usable content-type
 *  (documented default encoding is mp3). */
const DEFAULT_MIME = "audio/mpeg";

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

export class DeepgramTtsError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures). */
  readonly status?: number;
  constructor(message: string, options?: { status?: number }) {
    super(message);
    this.name = "DeepgramTtsError";
    this.status = options?.status;
  }
}

// ─── Config accessors (TtsProfileConfig is Record<string, unknown>) ─────────

interface DeepgramTtsConfig {
  apiKey: string;
  /** speed — clamped to the documented [0.7, 1.5]; omitted → server
   *  default 1 (the field's own fallback). */
  speed?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseConfig(config: TtsProfileConfig): DeepgramTtsConfig {
  const raw = config["speed"];
  const speed = typeof raw === "number" && Number.isFinite(raw) ? clamp(raw, MIN_SPEED, MAX_SPEED) : undefined;
  const apiKey = config["apiKey"];
  return {
    apiKey: typeof apiKey === "string" ? apiKey : "",
    speed,
  };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function authHeaders(apiKey: string): Record<string, string> {
  // The API key rides the documented `Token` scheme (Bearer JWTs are an
  // alternative client flow we do not need).
  return { Authorization: `Token ${apiKey}` };
}

async function readErrorExcerpt(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > ERROR_BODY_EXCERPT_LENGTH
      ? `${text.slice(0, ERROR_BODY_EXCERPT_LENGTH)}…`
      : text;
  } catch {
    return "(unreadable error body)";
  }
}

async function expectOk(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  const excerpt = await readErrorExcerpt(response);
  throw new DeepgramTtsError(
    `Deepgram ${operation} failed with HTTP ${response.status}: ${excerpt || "(empty body)"}`,
    { status: response.status },
  );
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class DeepgramTtsBackend implements TtsBackend {
  private readonly cfg: DeepgramTtsConfig;

  constructor(config: TtsProfileConfig) {
    this.cfg = parseConfig(config);
  }

  private requireApiKey(): string {
    if (!this.cfg.apiKey) {
      throw new DeepgramTtsError("Deepgram backend requires a non-empty apiKey in the profile config.");
    }
    return this.cfg.apiKey;
  }

  async generate(req: TtsGenerateRequest): Promise<TtsAudioResult> {
    const apiKey = this.requireApiKey();

    // Model == voice: the aura model id doubles as the voice id. An empty
    // voiceId is legal here — the documented server default
    // (aura-asteria-en) applies when the `model` param is omitted.
    const url = new URL(`${DEEPGRAM_BASE_URL}/v1/speak`);
    const voice = req.voiceId.trim();
    if (voice) url.searchParams.set("model", voice);
    if (this.cfg.speed !== undefined) url.searchParams.set("speed", String(this.cfg.speed));

    // The endpoint answers with the raw audio stream; the content-type
    // header names the format (audio/mpeg for the default mp3).
    const response = await fetch(url, {
      method: "POST",
      headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({ text: req.text }),
    });
    await expectOk(response, "text-to-speech");
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim() || DEFAULT_MIME;
    return { audio: Buffer.from(await response.arrayBuffer()), mime };
  }

  async listVoices(): Promise<TtsVoiceInfo[]> {
    this.requireApiKey();
    const response = await fetch(`${DEEPGRAM_BASE_URL}/v1/models`, { headers: authHeaders(this.cfg.apiKey) });
    await expectOk(response, "model list");
    const parsed: unknown = await response.json();
    return parseVoicesList(parsed);
  }

  async probe(): Promise<TtsProbeResult> {
    if (!this.cfg.apiKey) {
      return { ok: false, detail: "apiKey is required for Deepgram." };
    }
    try {
      const response = await fetch(`${DEEPGRAM_BASE_URL}/v1/models`, { headers: authHeaders(this.cfg.apiKey) });
      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        return { ok: false, detail: `${response.status} ${excerpt || "(empty body)"}`.trim() };
      }
      return { ok: true, detail: "model list reachable" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  // Nothing to tear down — Deepgram has no local state.
  async dispose(): Promise<void> {}

  capabilities(): TtsBackendCapabilities {
    // No cloning in Deepgram's TTS product — supportsCloning false is what
    // hides the editor's clone section (wave-B acceptance pin).
    return { supportsCloning: false };
  }
}

// ─── Response parsing (unknown at the fetch edge) ────────────────────────────

interface ParsedDeepgramModel {
  name: string;
  canonical_name: string;
  architecture?: string;
  languages?: unknown;
  metadata?: unknown;
}

function isParsedModel(value: unknown): value is ParsedDeepgramModel {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["name"] === "string" &&
    entry["name"].length > 0 &&
    typeof entry["canonical_name"] === "string" &&
    entry["canonical_name"].length > 0
  );
}

/** The documented id shape is `[family]-[voicename]-[language]` (at least
 *  three dash-separated lowercase segments). This is a shape check on the
 *  LIVE feed, not a baked roster — non-matching tts entries are skipped
 *  rather than guessed at. */
function matchesDocumentedIdShape(canonicalName: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+){2,}$/.test(canonicalName);
}

function readAccent(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const accent = (metadata as Record<string, unknown>)["accent"];
  return typeof accent === "string" && accent.length > 0 ? accent : undefined;
}

/** languages is e.g. ["en", "en-US"] — the LAST entry is the most specific
 *  (region) form and plays the lang role in pickers. */
function readRegionLanguage(languages: unknown): string {
  if (!Array.isArray(languages)) return "";
  const last = languages[languages.length - 1];
  return typeof last === "string" ? last : "";
}

function toVoiceInfo(entry: ParsedDeepgramModel): TtsVoiceInfo {
  const accent = readAccent(entry.metadata);
  const region = readRegionLanguage(entry.languages);
  // Aura-2 is the current generation; v1 voices get an explicit marker so
  // the picker never silently mixes generations.
  const generation = entry.architecture === "aura-2" ? "" : " · aura-1";
  const parts = [entry.name, accent, region].filter((part) => typeof part === "string" && part.length > 0);
  return {
    id: entry.canonical_name,
    label: `${parts.join(" · ")}${generation}`,
    lang: region.toLowerCase(),
  };
}

/** /v1/models → {stt: [...], tts: [...]}: the response's own tts array IS
 *  the catalog (STT entries are irrelevant). */
export function parseVoicesList(parsed: unknown): TtsVoiceInfo[] {
  if (typeof parsed !== "object" || parsed === null) {
    throw new DeepgramTtsError("Deepgram /v1/models returned a non-object payload.");
  }
  const tts = (parsed as Record<string, unknown>)["tts"];
  if (!Array.isArray(tts)) {
    throw new DeepgramTtsError("Deepgram /v1/models payload is missing the 'tts' array.");
  }
  return tts
    .filter(isParsedModel)
    .filter((entry) => matchesDocumentedIdShape(entry.canonical_name))
    .map(toVoiceInfo)
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ─── Registry wiring ─────────────────────────────────────────────────────────

export const deepgramTtsFactory: TtsBackendFactory = (config: TtsProfileConfig) =>
  new DeepgramTtsBackend(config);

// Module-scope registration (protocol-registry pattern): importing this
// adapter makes the 'deepgram' slug creatable via the registry.
registerTtsBackend(TTS_BACKEND.Deepgram, deepgramTtsFactory);
