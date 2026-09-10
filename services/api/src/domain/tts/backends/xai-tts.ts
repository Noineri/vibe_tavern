/**
 * @module tts/backends/xai-tts
 *
 * Native xAI (Grok Voice) TTS adapter (TPE-15, Wave D — direct provider,
 * own credentials; previously reachable only via the OpenRouter
 * aggregator profile). Surface: probe / voices / synthesis. No cloning.
 *
 * API facts (docs.x.ai, verified 2026-09-10 — pages fetched via their
 * machine-readable .md mirrors):
 * - Base URL https://api.x.ai; auth `Authorization: Bearer xai-...`.
 * - POST /v1/tts — JSON body: { text (≤15,000 chars, speech tags
 *   supported), voice_id (case-insensitive; built-in ids or a custom voice
 *   id), language (REQUIRED — BCP-47 code or "auto"; 20 documented
 *   languages incl. ru), output_format { codec, sample_rate, bit_rate }?,
 *   speed (0.7–1.5)? }. Response body = raw audio bytes (default MP3
 *   24 kHz / 128 kbps; we pin the documented default shape explicitly).
 *   Also available but NOT wired: text_normalization, with_timestamps
 *   (JSON envelope), replace (pronunciation map), the bidirectional
 *   WebSocket streaming endpoint — our generate() buffers, same contract
 *   as every native backend here.
 * - GET /v1/tts/voices — { voices: [{ voice_id, name }] }; the built-in
 *   roster (custom voices do NOT appear here).
 * - GET /v1/custom-voices?limit — team's cloned voices (paginated
 *   { voices: [{ voice_id, name, ... }], pagination_token? }); valid
 *   voice_id values for synthesis, so listVoices() merges both rosters.
 * - Cloning (POST /v1/custom-voices multipart) is gated to Enterprise
 *   contracts AND the feature is US-only — capabilities().supportsCloning
 *   stays false (same ruling as Google Cloud's gated Custom Voice
 *   program); the console's free voice library + this list endpoint are
 *   the discovery path for already-created custom voices.
 */

import { TTS_BACKEND } from "@vibe-tavern/domain";
import type { TtsProfileConfig } from "@vibe-tavern/domain";

import type {
  TtsBackend,
  TtsBackendCapabilities,
  TtsBackendFactory,
  TtsAudioResult,
  TtsGenerateRequest,
  TtsProbeResult,
  TtsVoiceInfo,
} from "../tts-backend.js";
import { registerTtsBackend } from "../tts-registry.js";

const XAI_BASE_URL = "https://api.x.ai";

/** Fixed output format — the documented default shape (MP3 24 kHz /
 *  128 kbps), pinned explicitly so a server-side default change can never
 *  silently alter what we store. */
const OUTPUT_CODEC = "mp3";
const OUTPUT_SAMPLE_RATE = 24000;
const OUTPUT_BIT_RATE = 128000;

const MIN_SPEED = 0.7;
const MAX_SPEED = 1.5;

/** language is REQUIRED by the API — "auto" (documented auto-detect) is
 *  the profile-less default. */
const DEFAULT_LANGUAGE = "auto";

/** Custom-voices page size + hard page cap (the pagination_token loop
 *  mirrors Cartesia's has_more guard). */
const CUSTOM_VOICES_PAGE_LIMIT = 100;
const CUSTOM_VOICES_MAX_PAGES = 10;

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

export class XaiTtsError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures). */
  readonly status?: number;
  constructor(message: string, options?: { status?: number }) {
    super(message);
    this.name = "XaiTtsError";
    this.status = options?.status;
  }
}

// ─── Config accessors (TtsProfileConfig is Record<string, unknown>) ─────────

interface XaiTtsConfig {
  apiKey: string;
  /** REQUIRED synthesis param — BCP-47 or "auto" (auto-detect). */
  language: string;
  /** speed multiplier — clamped to the documented [0.7, 1.5]. */
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

function parseConfig(config: TtsProfileConfig): XaiTtsConfig {
  const speed = readNumber(config, "speed");
  return {
    apiKey: readString(config, "apiKey") ?? "",
    language: readString(config, "language") ?? DEFAULT_LANGUAGE,
    // A hand-edited profile must never send out-of-contract values.
    speed: speed === undefined ? undefined : clamp(speed, MIN_SPEED, MAX_SPEED),
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
  throw new XaiTtsError(
    `xAI ${operation} failed with HTTP ${response.status}: ${excerpt || "(empty body)"}`,
    { status: response.status },
  );
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class XaiTtsBackend implements TtsBackend {
  private readonly cfg: XaiTtsConfig;

  constructor(config: TtsProfileConfig) {
    this.cfg = parseConfig(config);
  }

  private requireApiKey(): string {
    if (!this.cfg.apiKey) {
      throw new XaiTtsError("xAI backend requires a non-empty apiKey in the profile config.");
    }
    return this.cfg.apiKey;
  }

  async generate(req: TtsGenerateRequest): Promise<TtsAudioResult> {
    const apiKey = this.requireApiKey();
    const voiceId = req.voiceId.trim();
    if (!voiceId) {
      throw new XaiTtsError("xAI generate requires a non-empty voiceId.");
    }

    const body: Record<string, unknown> = {
      text: req.text,
      voice_id: voiceId,
      // language is REQUIRED by the wire — "auto" auto-detects.
      language: this.cfg.language,
      output_format: {
        codec: OUTPUT_CODEC,
        sample_rate: OUTPUT_SAMPLE_RATE,
        bit_rate: OUTPUT_BIT_RATE,
      },
    };
    if (this.cfg.speed !== undefined) body.speed = this.cfg.speed;
    // `instructions` has no xAI equivalent (expressive delivery comes via
    // inline speech tags in the text) and `req.speed` is a transient
    // playback hint — this adapter owns speed via the profile config, the
    // same contract choice as the Cartesia/ElevenLabs adapters.

    const response = await fetch(`${XAI_BASE_URL}/v1/tts`, {
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

    // Built-in roster: GET /v1/tts/voices (custom voices never appear here).
    const builtinResponse = await fetch(`${XAI_BASE_URL}/v1/tts/voices`, {
      headers: authHeaders(this.cfg.apiKey),
    });
    await expectOk(builtinResponse, "voice list");
    out.push(...parseVoiceRoster(await builtinResponse.json(), "builtin"));

    // Team custom voices: GET /v1/custom-voices (paginated) — valid
    // voice_id values for synthesis, so they join the picker with a
    // "mine" marker (ElevenLabs/Cartesia label convention).
    let paginationToken: string | undefined;
    for (let page = 0; page < CUSTOM_VOICES_MAX_PAGES; page++) {
      const url = new URL(`${XAI_BASE_URL}/v1/custom-voices`);
      url.searchParams.set("limit", String(CUSTOM_VOICES_PAGE_LIMIT));
      if (paginationToken !== undefined) url.searchParams.set("pagination_token", paginationToken);
      const response = await fetch(url, { headers: authHeaders(this.cfg.apiKey) });
      // A 403 here means the team has no custom-voices access at all —
      // the built-in roster above still stands on its own.
      if (response.status === 403) break;
      await expectOk(response, "custom voice list");
      const parsed: unknown = await response.json();
      const pageResult = parseCustomVoicesPage(parsed);
      out.push(...pageResult.voices);
      if (pageResult.paginationToken === undefined || pageResult.voices.length === 0) break;
      paginationToken = pageResult.paginationToken;
    }

    return out;
  }

  async probe(): Promise<TtsProbeResult> {
    if (!this.cfg.apiKey) {
      return { ok: false, detail: "apiKey is required for xAI." };
    }
    try {
      const response = await fetch(`${XAI_BASE_URL}/v1/tts/voices`, {
        headers: authHeaders(this.cfg.apiKey),
      });
      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        return { ok: false, detail: `${response.status} ${excerpt || "(empty body)"}`.trim() };
      }
      return { ok: true, detail: "voices endpoint reachable" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  // Nothing to tear down — xAI has no local state.
  async dispose(): Promise<void> {}

  capabilities(): TtsBackendCapabilities {
    // Custom Voices API cloning is Enterprise-gated + US-only (docs
    // warning, verified 2026-09-10) — same ruling as Google Cloud's gated
    // program: the clone section stays hidden; already-created custom
    // voices remain reachable through listVoices().
    return { supportsCloning: false };
  }
}

// ─── Response parsing (unknown at the fetch edge) ────────────────────────────

interface ParsedXaiVoice {
  voice_id: string;
  name?: string;
}

function isParsedVoice(value: unknown): value is ParsedXaiVoice {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.voice_id !== "string" || entry.voice_id.length === 0) return false;
  if (entry.name !== undefined && typeof entry.name !== "string") return false;
  return true;
}

function toVoiceInfo(entry: ParsedXaiVoice, mine: boolean): TtsVoiceInfo {
  const name = entry.name ?? entry.voice_id;
  return {
    id: entry.voice_id,
    label: mine ? `${name} · mine` : name,
    // The built-in roster is language-agnostic (one voice speaks all 20
    // documented languages) — "multi" is the honest marker.
    lang: "multi",
  };
}

export function parseVoiceRoster(parsed: unknown, kind: "builtin" | "custom"): TtsVoiceInfo[] {
  if (typeof parsed !== "object" || parsed === null) {
    throw new XaiTtsError("xAI voices endpoint returned a non-object payload.");
  }
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.voices)) {
    throw new XaiTtsError("xAI voices response is missing the 'voices' array.");
  }
  return root.voices.filter(isParsedVoice).map((v) => toVoiceInfo(v, kind === "custom"));
}

function parseCustomVoicesPage(parsed: unknown): { voices: TtsVoiceInfo[]; paginationToken?: string } {
  const voices = parseVoiceRoster(parsed, "custom");
  const root = parsed as Record<string, unknown>;
  const token = typeof root.pagination_token === "string" && root.pagination_token.length > 0
    ? root.pagination_token
    : undefined;
  return { voices, paginationToken: token };
}

// ─── Registry wiring ─────────────────────────────────────────────────────────

export const xaiTtsFactory: TtsBackendFactory = (config: TtsProfileConfig) =>
  new XaiTtsBackend(config);

// Module-scope registration (protocol-registry pattern): importing this
// adapter makes the 'xai' slug creatable via the registry.
registerTtsBackend(TTS_BACKEND.Xai, xaiTtsFactory);
