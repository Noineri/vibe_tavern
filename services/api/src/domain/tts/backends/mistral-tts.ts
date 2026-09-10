/**
 * @module tts/backends/mistral-tts
 *
 * Native Mistral Voxtral Mini TTS adapter (TPE-16, Wave D — direct provider,
 * own credentials; previously reachable only via the OpenRouter aggregator
 * profile). Surface: probe / voices / synthesis / cloneVoice.
 *
 * API facts (docs.mistral.ai + the Speakeasy-generated official Python SDK
 * + the official cookbook `mistral/tts/sts_demo.py`, verified 2026-09-10):
 * - Base URL https://api.mistral.ai; auth `Authorization: Bearer`.
 * - POST /v1/audio/speech — snake_case JSON body: { input (required),
 *   model?, voice_id?, ref_audio?, response_format? ("pcm"|"wav"|"mp3"|
 *   "flac"|"opus"), stream?, metadata?, prompt_cache_key? }.
 *   Non-stream response: { audio_data: base64 }. stream=true switches to
 *   SSE `speech.audio.delta`/`speech.audio.done` with float32 PCM 24 kHz —
 *   NOT wired (buffered first, same contract as every native backend).
 * - voice_id is the voice SLUG for presets (cookbook: "gb_jane_neutral";
 *   SDK doc: "The preset or custom voice to use") — preset slugs carry the
 *   emotion suffix, which is exactly what OpenRouter surfaces as ids.
 *   Custom (cloned) voices have an optional slug and a required UUID id;
 *   the voices CRUD paths key on the UUID, so this adapter's voice
 *   identity is `slug ?? id` — slug when present, UUID otherwise.
 * - Model: pinned `voxtral-mini-tts-2603` (official cookbook; no TTS
 *   models-list endpoint exists — static default + editable input field).
 * - GET /v1/audio/voices?limit&offset&type — OFFSET pagination (SDK:
 *   limit default 10, offset default 0, type "all"|"presets"|"customs");
 *   response { items: VoiceResponse[], total, page, page_size, total_pages }.
 *   VoiceResponse = { name (req), slug?, languages?, gender?, age?, tags?,
 *   color?, description?, retention_notice?, id (req, UUID), created_at,
 *   user_id (nullable — null = preset, set = custom) , trimmed_seconds? }.
 * - POST /v1/audio/voices — JSON clone: { name (req), sample_audio (req,
 *   base64), sample_filename? (original filename for extension
 *   detection), slug?, languages?, gender?, ... } → VoiceResponse.
 * - Errors: 422 HTTPValidationError; 403 content moderation is documented
 *   — the error ladder surfaces the upstream body detail verbatim.
 */

import { TTS_BACKEND } from "@vibe-tavern/domain";
import type { TtsProfileConfig } from "@vibe-tavern/domain";

import type {
  TtsBackend,
  TtsBackendCapabilities,
  TtsBackendFactory,
  TtsAudioResult,
  TtsCloneRequest,
  TtsGenerateRequest,
  TtsProbeResult,
  TtsVoiceInfo,
} from "../tts-backend.js";
import { registerTtsBackend } from "../tts-registry.js";

const MISTRAL_BASE_URL = "https://api.mistral.ai";

/** Official cookbook model id (no TTS models-list endpoint exists). */
const DEFAULT_MODEL = "voxtral-mini-tts-2603";

/** Buffered default — browser-playable container; pcm (raw float32) is
 *  deliberately NOT offered in the UI spec: it carries no container
 *  header and cannot be played back by a bare <audio> element. */
const DEFAULT_RESPONSE_FORMAT = "mp3";

type MistralResponseFormat = "pcm" | "wav" | "mp3" | "flac" | "opus";

const RESPONSE_FORMATS: ReadonlySet<string> = new Set(["pcm", "wav", "mp3", "flac", "opus"]);

const FORMAT_MIME: Record<MistralResponseFormat, string> = {
  pcm: "audio/pcm",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  opus: "audio/ogg",
};

/** Voices list page size + hard page cap (offset pagination). */
const VOICES_PAGE_LIMIT = 100;
const VOICES_MAX_PAGES = 20;

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

export class MistralTtsError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures). */
  readonly status?: number;
  constructor(message: string, options?: { status?: number }) {
    super(message);
    this.name = "MistralTtsError";
    this.status = options?.status;
  }
}

// ─── Config accessors (TtsProfileConfig is Record<string, unknown>) ─────────

interface MistralTtsConfig {
  apiKey: string;
  model: string;
  responseFormat: MistralResponseFormat;
}

function readString(config: TtsProfileConfig, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseConfig(config: TtsProfileConfig): MistralTtsConfig {
  const format = readString(config, "responseFormat");
  return {
    apiKey: readString(config, "apiKey") ?? "",
    model: readString(config, "model") ?? DEFAULT_MODEL,
    // A hand-edited profile must never send out-of-enum values.
    responseFormat: format !== undefined && RESPONSE_FORMATS.has(format)
      ? (format as MistralResponseFormat)
      : DEFAULT_RESPONSE_FORMAT,
  };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
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
  throw new MistralTtsError(
    `Mistral ${operation} failed with HTTP ${response.status}: ${excerpt || "(empty body)"}`,
    { status: response.status },
  );
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class MistralTtsBackend implements TtsBackend {
  private readonly cfg: MistralTtsConfig;

  constructor(config: TtsProfileConfig) {
    this.cfg = parseConfig(config);
  }

  private requireApiKey(): string {
    if (!this.cfg.apiKey) {
      throw new MistralTtsError("Mistral backend requires a non-empty apiKey in the profile config.");
    }
    return this.cfg.apiKey;
  }

  async generate(req: TtsGenerateRequest): Promise<TtsAudioResult> {
    const apiKey = this.requireApiKey();
    const voiceId = req.voiceId.trim();
    if (!voiceId) {
      throw new MistralTtsError("Mistral generate requires a non-empty voiceId.");
    }

    const body: Record<string, unknown> = {
      input: req.text,
      model: this.cfg.model,
      voice_id: voiceId,
      response_format: this.cfg.responseFormat,
    };
    // No speed/instructions equivalents exist on this wire (SpeechRequest
    // has none); `instructions` is dropped, same contract as the Gemini
    // adapter. stream stays false — buffered contract.

    const response = await fetch(`${MISTRAL_BASE_URL}/v1/audio/speech`, {
      method: "POST",
      headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await expectOk(response, "text-to-speech");

    const parsed: unknown = await response.json();
    const audioData = extractAudioData(parsed);
    return {
      audio: Buffer.from(audioData, "base64"),
      mime: FORMAT_MIME[this.cfg.responseFormat],
    };
  }

  async listVoices(): Promise<TtsVoiceInfo[]> {
    this.requireApiKey();
    const out: TtsVoiceInfo[] = [];

    // Offset pagination: ?limit=100&offset=N&type=all — loop until the
    // offset passes total (or items run dry; hard page cap as a guard).
    for (let page = 0; page < VOICES_MAX_PAGES; page++) {
      const offset = page * VOICES_PAGE_LIMIT;
      const url = new URL(`${MISTRAL_BASE_URL}/v1/audio/voices`);
      url.searchParams.set("limit", String(VOICES_PAGE_LIMIT));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("type", "all");
      const response = await fetch(url, { headers: authHeaders(this.cfg.apiKey) });
      await expectOk(response, "voice list");
      const parsed: unknown = await response.json();
      const pageResult = parseVoiceListResponse(parsed);
      out.push(...pageResult.items);
      if (pageResult.items.length === 0 || out.length >= pageResult.total) break;
    }

    return out;
  }

  async cloneVoice(req: TtsCloneRequest): Promise<TtsVoiceInfo> {
    const apiKey = this.requireApiKey();
    if (!req.name.trim()) {
      throw new MistralTtsError("Mistral voice clone requires a non-empty name.");
    }
    if (req.referenceAudio.length === 0) {
      throw new MistralTtsError("Mistral voice clone requires a non-empty reference audio sample.");
    }

    const body: Record<string, unknown> = {
      name: req.name.trim(),
      sample_audio: req.referenceAudio.toString("base64"),
      // "Original filename for extension detection" — derived from the
      // mime type so the API sees a supported extension (Cartesia
      // filenameForMime convention).
      sample_filename: sampleFilenameForMime(req.mimeType),
    };

    const response = await fetch(`${MISTRAL_BASE_URL}/v1/audio/voices`, {
      method: "POST",
      headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await expectOk(response, "voice clone");
    const parsed: unknown = await response.json();
    return parseVoiceResponse(parsed);
  }

  async probe(): Promise<TtsProbeResult> {
    if (!this.cfg.apiKey) {
      return { ok: false, detail: "apiKey is required for Mistral." };
    }
    try {
      const url = new URL(`${MISTRAL_BASE_URL}/v1/audio/voices`);
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

  // Nothing to tear down — Mistral has no local state.
  async dispose(): Promise<void> {}

  capabilities(): TtsBackendCapabilities {
    // POST /v1/audio/voices clone (name + base64 sample) is open to every
    // account — unlike xAI's Enterprise-gated program. No documented
    // size/format limits surfaced on the reference page, so no formats /
    // maxSizeMb claims are made (honesty rule).
    return { supportsCloning: true };
  }
}

// ─── Response parsing (unknown at the fetch edge) ────────────────────────────

interface ParsedVoiceResponse {
  name: string;
  slug?: string;
  languages?: string[];
  id: string;
  /** null = preset voice; a set user_id = custom (cloned) voice. */
  userId: string | null;
}

function parseVoiceResponse(value: unknown): TtsVoiceInfo {
  if (typeof value !== "object" || value === null) {
    throw new MistralTtsError("Mistral voice response is not an object.");
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== "string" || entry.name.length === 0) {
    throw new MistralTtsError("Mistral voice response is missing the required 'name'.");
  }
  if (typeof entry.id !== "string" || entry.id.length === 0) {
    throw new MistralTtsError("Mistral voice response is missing the required 'id'.");
  }
  const slug = typeof entry.slug === "string" && entry.slug.length > 0 ? entry.slug : undefined;
  const languages = Array.isArray(entry.languages)
    ? entry.languages.filter((l): l is string => typeof l === "string")
    : undefined;
  const parsed: ParsedVoiceResponse = {
    name: entry.name,
    slug,
    languages,
    id: entry.id,
    userId: typeof entry.user_id === "string" ? entry.user_id : null,
  };
  return toVoiceInfo(parsed);
}

function toVoiceInfo(v: ParsedVoiceResponse): TtsVoiceInfo {
  // Voice identity: slug when present (that is what speech.voice_id takes
  // for presets — cookbook "gb_jane_neutral"), UUID otherwise (customs
  // whose slug is unset; the voices CRUD keys on the UUID).
  const id = v.slug ?? v.id;
  // Label: name, disambiguated by the slug when they differ — preset
  // slugs carry the emotion suffix (…_neutral / …_sad), and two presets
  // can share a display name across emotions.
  const label = v.slug !== undefined && v.slug !== v.name ? `${v.name} · ${v.slug}` : v.name;
  return {
    id,
    label: v.userId !== null ? `${label} · mine` : label,
    lang: v.languages !== undefined && v.languages.length > 0 ? v.languages[0]! : "multi",
  };
}

function parseVoiceListResponse(parsed: unknown): { items: TtsVoiceInfo[]; total: number } {
  if (typeof parsed !== "object" || parsed === null) {
    throw new MistralTtsError("Mistral voices endpoint returned a non-object payload.");
  }
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.items)) {
    throw new MistralTtsError("Mistral voices response is missing the 'items' array.");
  }
  if (typeof root.total !== "number" || !Number.isFinite(root.total)) {
    throw new MistralTtsError("Mistral voices response is missing the 'total' number.");
  }
  const items = root.items.map((entry) => parseVoiceResponse(entry));
  return { items, total: root.total };
}

function extractAudioData(parsed: unknown): string {
  if (typeof parsed !== "object" || parsed === null) {
    throw new MistralTtsError("Mistral speech response is not an object.");
  }
  const audioData = (parsed as Record<string, unknown>).audio_data;
  if (typeof audioData !== "string" || audioData.length === 0) {
    throw new MistralTtsError("Mistral speech response is missing the base64 'audio_data' field.");
  }
  return audioData;
}

function sampleFilenameForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("flac")) return "sample.flac";
  if (normalized.includes("wav")) return "sample.wav";
  if (normalized.includes("ogg")) return "sample.ogg";
  if (normalized.includes("webm")) return "sample.webm";
  // audio/mpeg, audio/mp3 and everything else audio/* ride as mp3 — the
  // clone route already rejected non-audio mimes upstream.
  return "sample.mp3";
}

// ─── Registry wiring ─────────────────────────────────────────────────────────

export const mistralTtsFactory: TtsBackendFactory = (config: TtsProfileConfig) =>
  new MistralTtsBackend(config);

// Module-scope registration (protocol-registry pattern): importing this
// adapter makes the 'mistral' slug creatable via the registry.
registerTtsBackend(TTS_BACKEND.Mistral, mistralTtsFactory);
