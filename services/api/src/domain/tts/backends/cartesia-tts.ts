/**
 * @module tts/backends/cartesia-tts
 *
 * Native Cartesia TTS adapter (TPE-4, first Wave A provider — pilot for the
 * X-0 guide `docs/guides/adding-a-tts-provider.md`). Full surface: probe /
 * models / voices / synthesis / cloneVoice (the TPE-3 clone infrastructure's
 * first native consumer).
 *
 * API facts (docs.cartesia.ai, verified 2026-08-31 — pages fetched via their
 * machine-readable .md mirrors + OpenAPI `/latest.yml` excerpts):
 * - Base URL https://api.cartesia.ai; auth `Authorization: Bearer sk_car_...`
 *   (APIKeyAuth: http bearer); EVERY request requires the `Cartesia-Version`
 *   header. Reference pages document exactly one enum value today:
 *   `2026-03-01` (the carteia-js SDK defaults to a newer 2026-08-14 — we are
 *   raw-fetch, so we send the documented value; single constant below).
 * - POST /tts/bytes — JSON body:
 *     { model_id, transcript, voice: { mode: "id", id },
 *       output_format: { container: "mp3", sample_rate, bit_rate },
 *       language?, generation_config?: { speed?, volume?, emotion? } }
 *   Response body = raw audio bytes with an audio content-type.
 *   `generation_config` is "available on sonic-3 and sonic-3.5 ... not
 *   available on earlier models" — this adapter only sends it for
 *   sonic-3-family and sonic-latest model ids.
 * - GET /voices — cursor pagination: `?limit=100&starting_after=<lastId>`;
 *   response { data: Voice[], has_more }. Voice = { id, name, description,
 *   language, is_owner, is_public, gender?, created_at }.
 * - POST /voices/clone — multipart/form-data: `clip` (file; formats flac,
 *   mp3, mpeg, mpga, oga, ogg, wav, webm), `name`, `language` (REQUIRED,
 *   ISO 639-1), optional description/base_voice_id/access[type]=private.
 *   Response = VoiceMetadata { id, name, language, ... }.
 * - Models: no /models endpoint exists — the model catalog is documentation
 *   data (tts-models pages): sonic-3.5 (flagship, 42 langs; speed/volume
 *   temporarily disabled there), sonic-3 (full controls + [laughter]),
 *   sonic-latest (beta), sonic-turbo, sonic-2. listModels() serves this
 *   static documented catalog the same way the F8 "documented" filter
 *   serves groq/electronhub.
 */

import { TTS_BACKEND } from "@vibe-tavern/domain";
import type { TtsProfileConfig } from "@vibe-tavern/domain";

import type {
  TtsBackend,
  TtsBackendCapabilities,
  TtsBackendFactory,
  TtsModelInfo,
  TtsVoiceInfo,
  TtsAudioResult,
  TtsCloneRequest,
  TtsGenerateRequest,
  TtsProbeResult,
} from "../tts-backend.js";
import { registerTtsBackend } from "../tts-registry.js";

const CARTESIA_BASE_URL = "https://api.cartesia.ai";
/** The only value documented on every endpoint reference page today
 *  (2026-03-01). The JS SDK already defaults to a newer date — if Cartesia
 *  documents a new enum, this is the single line to bump. */
const CARTESIA_VERSION = "2026-03-01";

const DEFAULT_MODEL_ID = "sonic-3.5";
/** Fixed pilot output format — mp3/44.1kHz/128kbps (the playground's shape).
 *  mp3 needs container+sample_rate+bit_rate; wav/raw need encoding. */
const OUTPUT_SAMPLE_RATE = 44100;
const OUTPUT_BIT_RATE = 128000;

/** generation_config is sonic-3+ only ("not available on earlier models") —
 *  sonic-2 / sonic-turbo requests would 4xx if it rides along. */
function supportsGenerationConfig(modelId: string): boolean {
  return modelId.startsWith("sonic-3") || modelId === "sonic-latest";
}

/** Curated emotion subset — UI concern only (tts-backend-ui.ts owns the
 *  list); this adapter passes emotion through verbatim, so any documented
 *  enum value a hand-edited config carries is forwarded as-is. */

const MIN_SPEED = 0.6;
const MAX_SPEED = 1.5;

/** Clone sample limits mirrored from the docs (clip formats flac/mp3/mpeg/
 *  mpga/oga/ogg/wav/webm; route already caps 10 MB — the hints below drive
 *  client-side validation in the clone section). */
const CLONE_FORMATS = ["flac", "mp3", "wav", "ogg", "webm"];
const CLONE_MAX_SIZE_MB = 10;

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

/** Pagination: page size + hard page cap (1000 voices) so a pathological
 *  has_more loop can never hang the editor. */
const VOICES_PAGE_LIMIT = 100;
const VOICES_MAX_PAGES = 10;

export class CartesiaTtsError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures). */
  readonly status?: number;
  constructor(message: string, options?: { status?: number }) {
    super(message);
    this.name = "CartesiaTtsError";
    this.status = options?.status;
  }
}

// ─── Config accessors (TtsProfileConfig is Record<string, unknown>) ─────────

interface CartesiaTtsConfig {
  apiKey: string;
  modelId: string;
  /** ISO 639-1 synthesis override ("The language that the given voice should
   *  speak the transcript in") — omitted from requests when unset. Also the
   *  clone fallback (clone REQUIRES a language; English-first default). */
  language?: string;
  /** generation_config.speed — clamped to the documented [0.6, 1.5]. */
  speed?: number;
  /** generation_config.emotion — passed through verbatim (any documented
   *  enum value; invalid values fail upstream with Cartesia's own message). */
  emotion?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readString(config: TtsProfileConfig, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(config: TtsProfileConfig, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseConfig(config: TtsProfileConfig): CartesiaTtsConfig {
  const speed = readNumber(config, "speed");
  return {
    apiKey: readString(config, "apiKey") ?? "",
    modelId: readString(config, "modelId") ?? DEFAULT_MODEL_ID,
    language: readString(config, "language"),
    // A hand-edited profile must never send out-of-contract values.
    speed: speed === undefined ? undefined : clamp(speed, MIN_SPEED, MAX_SPEED),
    emotion: readString(config, "emotion"),
  };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Cartesia-Version": CARTESIA_VERSION,
  };
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
  throw new CartesiaTtsError(
    `Cartesia ${operation} failed with HTTP ${response.status}: ${excerpt || "(empty body)"}`,
    { status: response.status },
  );
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class CartesiaTtsBackend implements TtsBackend {
  private readonly cfg: CartesiaTtsConfig;

  constructor(config: TtsProfileConfig) {
    this.cfg = parseConfig(config);
  }

  private requireApiKey(): string {
    if (!this.cfg.apiKey) {
      throw new CartesiaTtsError("Cartesia backend requires a non-empty apiKey in the profile config.");
    }
    return this.cfg.apiKey;
  }

  async generate(req: TtsGenerateRequest): Promise<TtsAudioResult> {
    const apiKey = this.requireApiKey();
    const voiceId = req.voiceId.trim();
    if (!voiceId) {
      throw new CartesiaTtsError("Cartesia generate requires a non-empty voiceId.");
    }

    const body: Record<string, unknown> = {
      model_id: this.cfg.modelId,
      transcript: req.text,
      // Voice embeddings die 2026-06-01 (tts-models/voice-ids) — mode:"id"
      // is the only path we ship.
      voice: { mode: "id", id: voiceId },
      output_format: {
        container: "mp3",
        sample_rate: OUTPUT_SAMPLE_RATE,
        bit_rate: OUTPUT_BIT_RATE,
      },
    };
    if (this.cfg.language !== undefined) body.language = this.cfg.language;

    // generation_config is sonic-3+ only; `instructions` has no Cartesia
    // equivalent (emotion is the parameter) and `req.speed` is a transient
    // playback hint — this adapter owns speed via the profile config, the
    // same contract choice as the ElevenLabs adapter.
    if (supportsGenerationConfig(this.cfg.modelId)) {
      const generationConfig: Record<string, unknown> = {};
      if (this.cfg.speed !== undefined) generationConfig.speed = this.cfg.speed;
      if (this.cfg.emotion !== undefined) generationConfig.emotion = this.cfg.emotion;
      if (Object.keys(generationConfig).length > 0) body.generation_config = generationConfig;
    }

    const response = await fetch(`${CARTESIA_BASE_URL}/tts/bytes`, {
      method: "POST",
      headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await expectOk(response, "text-to-speech");
    const audio = Buffer.from(await response.arrayBuffer());
    const mime = response.headers.get("content-type") ?? "audio/mpeg";
    return { audio, mime };
  }

  async listVoices(): Promise<TtsVoiceInfo[]> {
    this.requireApiKey();
    const out: TtsVoiceInfo[] = [];
    let startingAfter: string | undefined;
    // Cursor pagination: follow has_more via starting_after=<last id>.
    for (let page = 0; page < VOICES_MAX_PAGES; page++) {
      const url = new URL(`${CARTESIA_BASE_URL}/voices`);
      url.searchParams.set("limit", String(VOICES_PAGE_LIMIT));
      if (startingAfter !== undefined) url.searchParams.set("starting_after", startingAfter);
      const response = await fetch(url, { headers: authHeaders(this.cfg.apiKey) });
      await expectOk(response, "voice list");
      const parsed: unknown = await response.json();
      const pageVoices = parseVoicesPage(parsed);
      out.push(...pageVoices.voices);
      if (!pageVoices.hasMore || pageVoices.voices.length === 0) return out;
      startingAfter = pageVoices.voices[pageVoices.voices.length - 1].id;
    }
    return out;
  }

  async probe(): Promise<TtsProbeResult> {
    if (!this.cfg.apiKey) {
      return { ok: false, detail: "apiKey is required for Cartesia." };
    }
    try {
      const url = new URL(`${CARTESIA_BASE_URL}/voices`);
      url.searchParams.set("limit", "1");
      const response = await fetch(url, { headers: authHeaders(this.cfg.apiKey) });
      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        return { ok: false, detail: `${response.status} ${excerpt || "(empty body)"}`.trim() };
      }
      return { ok: true, detail: "voices endpoint reachable" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async cloneVoice(req: TtsCloneRequest): Promise<TtsVoiceInfo> {
    const apiKey = this.requireApiKey();
    // Clone language is REQUIRED by the API; the editor does not collect it
    // in v1 (English-first) — a hand-set config.language wins, "en" falls back.
    const language = this.cfg.language ?? "en";

    const form = new FormData();
    // Filename derived from the mime type so Cartesia sees a supported
    // extension (their format list is extension-keyed).
    form.append("clip", new Blob([new Uint8Array(req.referenceAudio)], { type: req.mimeType }), filenameForMime(req.mimeType));
    form.append("name", req.name);
    form.append("language", language);
    form.append("access[type]", "private");

    const response = await fetch(`${CARTESIA_BASE_URL}/voices/clone`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: form,
    });
    await expectOk(response, "voice clone");
    const parsed: unknown = await response.json();
    return parseCloneResponse(parsed);
  }

  // Nothing to tear down — Cartesia has no local state.
  async dispose(): Promise<void> {}

  capabilities(): TtsBackendCapabilities {
    // Static (unlike openai-compat, which learns cloning from the voices
    // route): Cartesia always supports cloning.
    return {
      supportsCloning: true,
      formats: [...CLONE_FORMATS],
      maxSizeMb: CLONE_MAX_SIZE_MB,
    };
  }
}

// ─── Response parsing (unknown at the fetch edge) ────────────────────────────

interface ParsedCartesiaVoice {
  id: string;
  name?: string;
  description?: string;
  language?: string;
  is_owner?: boolean;
}

function isParsedVoice(value: unknown): value is ParsedCartesiaVoice {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) return false;
  if (entry.name !== undefined && typeof entry.name !== "string") return false;
  if (entry.description !== undefined && typeof entry.description !== "string") return false;
  if (entry.language !== undefined && typeof entry.language !== "string") return false;
  if (entry.is_owner !== undefined && typeof entry.is_owner !== "boolean") return false;
  return true;
}

/** Label convention follows the ElevenLabs adapter: `name · language`, plus
 *  a `· mine` suffix for organization-owned voices (clones) so the user can
 *  spot their own in the mixed library list. */
function toVoiceInfo(entry: ParsedCartesiaVoice): TtsVoiceInfo {
  const parts: string[] = [];
  if (entry.language) parts.push(entry.language);
  if (entry.is_owner) parts.push("mine");
  const suffix = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
  return {
    id: entry.id,
    label: `${entry.name ?? entry.id}${suffix}`,
    lang: entry.language ?? "multi",
  };
}

export function parseVoicesPage(parsed: unknown): { voices: TtsVoiceInfo[]; hasMore: boolean } {
  if (typeof parsed !== "object" || parsed === null) {
    throw new CartesiaTtsError("Cartesia /voices returned a non-object payload.");
  }
  const root = parsed as Record<string, unknown>;
  const rawData = root.data;
  if (!Array.isArray(rawData)) {
    throw new CartesiaTtsError("Cartesia /voices response is missing the 'data' array.");
  }
  const voices = rawData.filter(isParsedVoice).map(toVoiceInfo);
  const hasMore = root.has_more === true;
  return { voices, hasMore };
}

function parseCloneResponse(parsed: unknown): TtsVoiceInfo {
  if (typeof parsed !== "object" || parsed === null) {
    throw new CartesiaTtsError("Cartesia /voices/clone returned a non-object payload.");
  }
  const root = parsed as Record<string, unknown>;
  if (typeof root.id !== "string" || root.id.length === 0) {
    throw new CartesiaTtsError("Cartesia /voices/clone response is missing the voice 'id'.");
  }
  const name = typeof root.name === "string" ? root.name : root.id;
  const language = typeof root.language === "string" ? root.language : "multi";
  return { id: root.id, label: `${name} · ${language} · mine`, lang: language };
}

/** Map the client-validated mime type to a filename with an extension from
 *  Cartesia's supported list (flac/mp3/mpeg/mpga/oga/ogg/wav/webm). */
function filenameForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("flac")) return "clip.flac";
  if (normalized.includes("wav")) return "clip.wav";
  if (normalized.includes("ogg")) return "clip.ogg";
  if (normalized.includes("webm")) return "clip.webm";
  // audio/mpeg, audio/mp3 and everything else audio/* ride as mp3 — the
  // clone route already rejected non-audio mimes upstream.
  return "clip.mp3";
}

// ─── Registry wiring ─────────────────────────────────────────────────────────

export const cartesiaTtsFactory: TtsBackendFactory = (config: TtsProfileConfig) =>
  new CartesiaTtsBackend(config);

// Module-scope registration (protocol-registry pattern): importing this
// adapter makes the 'cartesia' slug creatable via the registry.
registerTtsBackend(TTS_BACKEND.Cartesia, cartesiaTtsFactory);
