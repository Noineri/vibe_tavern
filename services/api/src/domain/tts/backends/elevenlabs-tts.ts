/**
 * @module tts/backends/elevenlabs-tts
 *
 * Native ElevenLabs TTS adapter (TTS_PLAN TS-5b). Ships generate + voice list
 * only — voice cloning is DEFERRED by owner decision, so `cloneVoice` is not
 * implemented (the interface member stays absent; callers must gate on
 * capabilities.supportsCloning, which is false for this backend).
 *
 * API facts (elevenlabs.io API reference, verified 2026-08-27):
 * - POST /v1/text-to-speech/:voice_id?output_format=mp3_44100_128
 *   headers: xi-api-key + Content-Type: application/json
 *   body: { text, model_id, voice_settings? } — voice_settings is SNAKE_CASE,
 *   only keys the user configured.
 * - GET /v1/voices → { voices: [{ voice_id, name, labels?: { accent?, gender?, description? } }] }
 * - Models: eleven_multilingual_v2 (default), eleven_v3, eleven_flash_v2_5,
 *   eleven_turbo_v2_5.
 */

import { TTS_BACKEND } from "@vibe-tavern/domain";
import type { TtsProfileConfig } from "@vibe-tavern/domain";

import type { TtsBackend, TtsAudioResult, TtsBackendFactory, TtsGenerateRequest, TtsProbeResult, TtsVoiceInfo } from "../tts-backend.js";
import { registerTtsBackend } from "../tts-registry.js";

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";

const MIN_SPEED = 0.7;
const MAX_SPEED = 1.2;
const MIN_SLIDER = 0;
const MAX_SLIDER = 1;

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

/** Identity guard for parsed JSON voice entries (unknown at the fetch edge). */
interface ParsedVoiceEntry {
  voice_id: string;
  name?: string;
  labels?: { accent?: string; gender?: string; description?: string };
}

export class ElevenLabsTtsError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures). */
  readonly status?: number;
  constructor(message: string, options?: { status?: number }) {
    super(message);
    this.name = "ElevenLabsTtsError";
    this.status = options?.status;
  }
}

// ─── Config accessors (TtsProfileConfig is Record<string, unknown>) ─────────

interface ElevenLabsTtsConfig {
  apiKey: string;
  modelId: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  speed?: number;
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

function readBoolean(config: TtsProfileConfig, key: string): boolean | undefined {
  const value = config[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Read an optional number and clamp it into [min, max]. */
function readClampedNumber(
  config: TtsProfileConfig,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = readNumber(config, key);
  return value === undefined ? undefined : clamp(value, min, max);
}

function parseConfig(config: TtsProfileConfig): ElevenLabsTtsConfig {
  // Stability / similarity / style sliders and speed are clamped into the
  // ranges the ElevenLabs voice_settings contract actually accepts; a hand-
  // edited profile can carry out-of-range values and must never send them.
  return {
    apiKey: readString(config, "apiKey") ?? "",
    modelId: readString(config, "modelId") ?? DEFAULT_MODEL_ID,
    stability: readClampedNumber(config, "stability", MIN_SLIDER, MAX_SLIDER),
    similarityBoost: readClampedNumber(config, "similarityBoost", MIN_SLIDER, MAX_SLIDER),
    style: readClampedNumber(config, "style", MIN_SLIDER, MAX_SLIDER),
    useSpeakerBoost: readBoolean(config, "useSpeakerBoost"),
    speed: readClampedNumber(config, "speed", MIN_SPEED, MAX_SPEED),
  };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

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
  throw new ElevenLabsTtsError(
    `ElevenLabs ${operation} failed with HTTP ${response.status}: ${excerpt || "(empty body)"}`,
    { status: response.status },
  );
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/** Adapter for the native ElevenLabs TTS API (paid; ships in v1 with mocked
 *  tests — the owner's free testing budget narrows verification, not the
 *  feature set). */
export class ElevenLabsTtsBackend implements TtsBackend {
  private readonly cfg: ElevenLabsTtsConfig;

  constructor(config: TtsProfileConfig) {
    this.cfg = parseConfig(config);
  }

  async generate(req: TtsGenerateRequest): Promise<TtsAudioResult> {
    const apiKey = this.cfg.apiKey;
    if (!apiKey) {
      throw new ElevenLabsTtsError("ElevenLabs backend requires a non-empty apiKey in the profile config.");
    }
    const voiceId = req.voiceId.trim();
    if (!voiceId) {
      throw new ElevenLabsTtsError("ElevenLabs generate requires a non-empty voiceId.");
    }

    // `instructions` is NOT an ElevenLabs concept (style/pacing come from
    // textual cues + audio tags in the input itself), so it is intentionally
    // ignored here. `req.speed` is a transient playback-rate hint in the
    // shared contract; ElevenLabs speed is a persisted per-voice setting in
    // the profile config (voice_settings.speed), so this adapter uses the
    // config value, not the request field.
    const body: Record<string, unknown> = {
      text: req.text,
      model_id: this.cfg.modelId,
    };
    const voiceSettings: Record<string, unknown> = {};
    if (this.cfg.stability !== undefined) voiceSettings.stability = this.cfg.stability;
    if (this.cfg.similarityBoost !== undefined) voiceSettings.similarity_boost = this.cfg.similarityBoost;
    if (this.cfg.style !== undefined) voiceSettings.style = this.cfg.style;
    if (this.cfg.useSpeakerBoost !== undefined) voiceSettings.use_speaker_boost = this.cfg.useSpeakerBoost;
    if (this.cfg.speed !== undefined) voiceSettings.speed = this.cfg.speed;
    if (Object.keys(voiceSettings).length > 0) body.voice_settings = voiceSettings;

    const url = `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${DEFAULT_OUTPUT_FORMAT}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    await expectOk(response, "text-to-speech");
    const audio = Buffer.from(await response.arrayBuffer());
    const mime = response.headers.get("content-type") ?? "audio/mpeg";
    return { audio, mime };
  }

  async listVoices(): Promise<TtsVoiceInfo[]> {
    const apiKey = this.cfg.apiKey;
    if (!apiKey) {
      throw new ElevenLabsTtsError("ElevenLabs backend requires a non-empty apiKey in the profile config.");
    }
    const response = await fetch(`${ELEVENLABS_BASE_URL}/v1/voices`, {
      headers: { "xi-api-key": apiKey },
    });
    await expectOk(response, "voice list");
    const parsed: unknown = await response.json();
    return parseVoicesResponse(parsed);
  }

  async probe(): Promise<TtsProbeResult> {
    const apiKey = this.cfg.apiKey;
    if (!apiKey) {
      return { ok: false, detail: "apiKey is required for ElevenLabs." };
    }
    try {
      const response = await fetch(`${ELEVENLABS_BASE_URL}/v1/voices`, {
        headers: { "xi-api-key": apiKey },
      });
      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        return { ok: false, detail: `${response.status} ${excerpt || "(empty body)"}`.trim() };
      }
      const parsed: unknown = await response.json();
      const voices = parseVoicesResponse(parsed);
      return { ok: true, detail: `${voices.length} voices` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  // Nothing to tear down — ElevenLabs has no local state.
  async dispose(): Promise<void> {}
}

// ─── Voice-list parsing (unknown at the fetch edge) ──────────────────────────

function isParsedVoiceEntry(value: unknown): value is ParsedVoiceEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.voice_id !== "string" || entry.voice_id.length === 0) return false;
  if (entry.name !== undefined && typeof entry.name !== "string") return false;
  if (entry.labels !== undefined) {
    if (typeof entry.labels !== "object" || entry.labels === null) return false;
    const labels = entry.labels as Record<string, unknown>;
    for (const key of ["accent", "gender", "description"] as const) {
      if (labels[key] !== undefined && typeof labels[key] !== "string") return false;
    }
  }
  return true;
}

/** Maps an ElevenLabs voice entry to the shared TtsVoiceInfo shape. Voices are
 *  multilingual, so `lang` is the placeholder "multi" (matches Gemini). */
function toVoiceInfo(entry: ParsedVoiceEntry): TtsVoiceInfo {
  const parts: string[] = [];
  if (entry.labels?.accent) parts.push(entry.labels.accent);
  if (entry.labels?.gender) parts.push(entry.labels.gender);
  const suffix = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
  return {
    id: entry.voice_id,
    label: `${entry.name ?? entry.voice_id}${suffix}`,
    lang: "multi",
  };
}

export function parseVoicesResponse(parsed: unknown): TtsVoiceInfo[] {
  if (typeof parsed !== "object" || parsed === null) {
    throw new ElevenLabsTtsError("ElevenLabs /v1/voices returned a non-object payload.");
  }
  const root = parsed as Record<string, unknown>;
  const rawVoices = root.voices;
  if (!Array.isArray(rawVoices)) {
    throw new ElevenLabsTtsError("ElevenLabs /v1/voices response is missing the 'voices' array.");
  }
  return rawVoices.filter(isParsedVoiceEntry).map(toVoiceInfo);
}

// ─── Registry wiring ─────────────────────────────────────────────────────────

export const elevenLabsTtsFactory: TtsBackendFactory = (config: TtsProfileConfig) =>
  new ElevenLabsTtsBackend(config);

// Module-scope registration (protocol-registry pattern): importing this
// adapter makes the 'elevenlabs' slug creatable via the registry.
registerTtsBackend(TTS_BACKEND.ElevenLabs, elevenLabsTtsFactory);