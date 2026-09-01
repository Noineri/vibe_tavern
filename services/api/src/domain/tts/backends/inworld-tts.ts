/**
 * Inworld TTS backend (TPE-5).
 *
 * API facts below were verified 2026-08-31 against docs.inworld.ai — each
 * endpoint reference page embeds its full OpenAPI spec, fetched via the
 * machine-readable .md mirrors (llms.txt is the index):
 * - Base URL https://api.inworld.ai; auth is `Authorization: Basic
 *   <key>` — the key rides verbatim after the "Basic " prefix (the docs'
 *   own curl shape; keys from platform.inworld.ai are pre-encoded).
 * - POST /tts/v1/voice — JSON body {text (≤2000 chars), voiceId, modelId,
 *   audioConfig? {audioEncoding, sampleRateHertz?, bitRate?,
 *   speakingRate?}, language? (BCP-47, top-level — auto-detected from the
 *   text when omitted), deliveryMode? (enum STABLE/BALANCED/CREATIVE,
 *   inworld-tts-2 only — "ignored on other models"), temperature? (ignored
 *   on tts-2), ...}. Response is JSON {audioContent: base64 audio, usage}
 *   — NOT raw bytes (unlike Cartesia/ElevenLabs).
 * - GET /voices/v1/voices — pageToken pagination (pageSize ≤ 2000,
 *   nextPageToken empty = done; offset-based). Voice = {voiceId,
 *   displayName, langCode (upper-snake, e.g. EN_US), source: SYSTEM/IVC/
 *   PVC, gender?, tags?, ...}. SYSTEM = built-ins, IVC = workspace
 *   clones/designed voices.
 * - POST /voices/v1/voices:clone — JSON (not multipart): {displayName,
 *   langCode (enum incl. AUTO), voiceSamples: [{audioData: base64 (WAV or
 *   MP3 only), transcription?}]}. Best 10–15 s clip (longer is cut at
 *   15 s). Response {voice: {...}, audioSamplesValidated}.
 * - Models: the only list-models endpoint (/llm/v1alpha/models) is
 *   LLM-router models, not TTS — the TTS catalog is documentation data
 *   (tts/tts-models): inworld-tts-2 (steering, 100+ languages),
 *   inworld-tts-1.5-max / -mini (15 languages incl. ru), inworld-tts-1 /
 *   -1-max (deprecated). listModels() serves this static catalog (same
 *   F8 "documented" philosophy as Cartesia).
 * - deliveryMode enum discrepancy resolved: the OpenAPI + SDK agree on
 *   STABLE/BALANCED/CREATIVE; the llms.txt summary's "EXPRESSIVE" is a
 *   stale rewrite — the page-level OpenAPI is authoritative.
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

const INWORLD_BASE_URL = "https://api.inworld.ai";

const DEFAULT_MODEL_ID = "inworld-tts-2";

/** deliveryMode is inworld-tts-2 only ("the field is ignored on other
 *  models") — on other models the key never rides along. */
function supportsDeliveryMode(modelId: string): boolean {
  return modelId === "inworld-tts-2";
}

const DELIVERY_MODES = ["STABLE", "BALANCED", "CREATIVE"] as const;
type DeliveryMode = (typeof DELIVERY_MODES)[number];

/** audioConfig.speakingRate — documented range [0.5, 1.5], "above 0.8
 *  recommended"; a hand-edited profile must never send outside it. */
const MIN_SPEAKING_RATE = 0.5;
const MAX_SPEAKING_RATE = 1.5;

/** Clone sample limits mirrored from the docs: WAV/MP3 audio only (the
 *  voiceSamples[].audioData base64 field), route already caps 10 MB; best
 *  results with a 10–15 s clip. */
const CLONE_FORMATS = ["wav", "mp3"];
const CLONE_MAX_SIZE_MB = 10;

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

/** Voices pagination: page size + hard page cap (1000 voices) so a
 *  pathological nextPageToken loop can never hang the editor. */
const VOICES_PAGE_SIZE = 100;
const VOICES_MAX_PAGES = 10;

/** Clone langCode enum (docs: "extended language list for the voice clone
 *  feature"). AUTO = auto-detect — the safest default when the editor
 *  collects no language (v1). */
const CLONE_LANG_AUTO = "AUTO";
/** config.language (ISO 639-1, e.g. "ru") → clone langCode enum. Only the
 *  subset the enum actually contains; anything else falls back to AUTO. */
const LANGUAGE_TO_CLONE_CODE: Record<string, string> = {
  en: "EN_US",
  zh: "ZH_CN",
  ko: "KO_KR",
  ja: "JA_JP",
  ru: "RU_RU",
  it: "IT_IT",
  es: "ES_ES",
  pt: "PT_BR",
  de: "DE_DE",
  fr: "FR_FR",
  ar: "AR_SA",
  pl: "PL_PL",
  nl: "NL_NL",
  hi: "HI_IN",
  he: "HE_IL",
};

export class InworldTtsError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures). */
  readonly status?: number;
  constructor(message: string, options?: { status?: number }) {
    super(message);
    this.name = "InworldTtsError";
    this.status = options?.status;
  }
}

// ─── Config accessors (TtsProfileConfig is Record<string, unknown>) ─────────

interface InworldTtsConfig {
  apiKey: string;
  modelId: string;
  /** BCP-47 synthesis override — omitted when unset (the docs: language is
   *  auto-detected from the input text). Also feeds the clone langCode. */
  language?: string;
  /** audioConfig.speakingRate — clamped to the documented [0.5, 1.5]. */
  speed?: number;
  /** deliveryMode (tts-2 only) — validated against the documented enum. */
  deliveryMode?: DeliveryMode;
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

function parseConfig(config: TtsProfileConfig): InworldTtsConfig {
  const speed = readNumber(config, "speed");
  const rawDeliveryMode = readString(config, "deliveryMode");
  return {
    apiKey: readString(config, "apiKey") ?? "",
    modelId: readString(config, "modelId") ?? DEFAULT_MODEL_ID,
    language: readString(config, "language"),
    speed: speed === undefined ? undefined : clamp(speed, MIN_SPEAKING_RATE, MAX_SPEAKING_RATE),
    deliveryMode: DELIVERY_MODES.includes(rawDeliveryMode as DeliveryMode)
      ? (rawDeliveryMode as DeliveryMode)
      : undefined,
  };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function authHeaders(apiKey: string): Record<string, string> {
  // The key rides verbatim after "Basic " — the docs' own curl shape.
  return { Authorization: `Basic ${apiKey}` };
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
  throw new InworldTtsError(
    `Inworld ${operation} failed with HTTP ${response.status}: ${excerpt || "(empty body)"}`,
    { status: response.status },
  );
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class InworldTtsBackend implements TtsBackend {
  private readonly cfg: InworldTtsConfig;

  constructor(config: TtsProfileConfig) {
    this.cfg = parseConfig(config);
  }

  private requireApiKey(): string {
    if (!this.cfg.apiKey) {
      throw new InworldTtsError("Inworld backend requires a non-empty apiKey in the profile config.");
    }
    return this.cfg.apiKey;
  }

  async generate(req: TtsGenerateRequest): Promise<TtsAudioResult> {
    const apiKey = this.requireApiKey();
    const voiceId = req.voiceId.trim();
    if (!voiceId) {
      throw new InworldTtsError("Inworld generate requires a non-empty voiceId.");
    }

    const audioConfig: Record<string, unknown> = {
      // Defaults for sampleRateHertz (48000) and bitRate (128000) are the
      // documented ones — mp3 container, no need to send them.
      audioEncoding: "MP3",
    };
    // speakingRate lives inside audioConfig; config-owned like the other
    // native adapters (req.speed is a transient playback hint).
    if (this.cfg.speed !== undefined) audioConfig.speakingRate = this.cfg.speed;

    const body: Record<string, unknown> = {
      text: req.text,
      voiceId,
      modelId: this.cfg.modelId,
      audioConfig,
    };
    // Language is auto-detected from the input text when omitted — omit by
    // default so Russian voices speak Russian without forcing a profile knob.
    if (this.cfg.language !== undefined) body.language = this.cfg.language;
    // deliveryMode rides only on inworld-tts-2 ("ignored on other models").
    if (supportsDeliveryMode(this.cfg.modelId) && this.cfg.deliveryMode !== undefined) {
      body.deliveryMode = this.cfg.deliveryMode;
    }

    const response = await fetch(`${INWORLD_BASE_URL}/tts/v1/voice`, {
      method: "POST",
      headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await expectOk(response, "text-to-speech");
    const parsed: unknown = await response.json();
    const audioContent = parseAudioContent(parsed);
    // Response is JSON with base64 audio (audioContent), not raw bytes.
    return { audio: Buffer.from(audioContent, "base64"), mime: "audio/mpeg" };
  }

  async listVoices(): Promise<TtsVoiceInfo[]> {
    this.requireApiKey();
    const out: TtsVoiceInfo[] = [];
    let pageToken: string | undefined;
    // pageToken pagination: opaque cursor, empty/absent nextPageToken = done.
    for (let page = 0; page < VOICES_MAX_PAGES; page++) {
      const url = new URL(`${INWORLD_BASE_URL}/voices/v1/voices`);
      url.searchParams.set("pageSize", String(VOICES_PAGE_SIZE));
      if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
      const response = await fetch(url, { headers: authHeaders(this.cfg.apiKey) });
      await expectOk(response, "voice list");
      const parsed: unknown = await response.json();
      const pageVoices = parseVoicesPage(parsed);
      out.push(...pageVoices.voices);
      if (pageVoices.nextPageToken === "" || pageVoices.voices.length === 0) return out;
      pageToken = pageVoices.nextPageToken;
    }
    return out;
  }

  async listModels(): Promise<TtsModelInfo[]> {
    // Live discovery (owner audit 2026-09-01: static catalogs out): Inworld
    // documents GET /llm/v1alpha/models — "List all available models" across
    // the Router AND Inworld first-party TTS/STT/Realtime endpoints
    // (docs.inworld.ai/api-reference/modelsAPI/modelservice/list-models).
    // The TTS entries are the models whose documented `spec.outputModalities`
    // include "audio" (the page example shows the field on an LLM entry) —
    // a criterion, not a list: new TTS releases appear without a code change.
    const apiKey = this.requireApiKey();
    const response = await fetch(`${INWORLD_BASE_URL}/llm/v1alpha/models`, {
      headers: authHeaders(apiKey),
    });
    if (!response.ok) {
      const excerpt = await readErrorExcerpt(response);
      throw new InworldTtsError(
        `Inworld model list failed with HTTP ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
      );
    }
    const root = (await response.json().catch(() => null)) as unknown;
    const models =
      typeof root === "object" && root !== null ? (root as Record<string, unknown>).models : undefined;
    if (!Array.isArray(models)) return [];
    const out: TtsModelInfo[] = [];
    for (const entry of models) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const id = record.model;
      if (typeof id !== "string" || id.length === 0) continue;
      const spec =
        typeof record.spec === "object" && record.spec !== null
          ? (record.spec as Record<string, unknown>).outputModalities
          : undefined;
      if (!Array.isArray(spec) || !spec.includes("audio")) continue;
      out.push({ id, label: id });
    }
    return out;
  }

  async probe(): Promise<TtsProbeResult> {
    if (!this.cfg.apiKey) {
      return { ok: false, detail: "apiKey is required for Inworld." };
    }
    try {
      const url = new URL(`${INWORLD_BASE_URL}/voices/v1/voices`);
      url.searchParams.set("pageSize", "1");
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
    // Clone langCode: a hand-set config.language maps into the enum; AUTO
    // (documented auto-detect) is the default — no wrong-language lock-in.
    const langCode = LANGUAGE_TO_CLONE_CODE[this.cfg.language ?? ""] ?? CLONE_LANG_AUTO;

    // JSON body (not multipart): the sample rides as base64 audioData. The
    // endpoint supports WAV and MP3 samples; the clone route's client-side
    // validation filters by capabilities().formats before we get here.
    const body = {
      displayName: req.name,
      langCode,
      voiceSamples: [
        {
          audioData: Buffer.from(new Uint8Array(req.referenceAudio)).toString("base64"),
        },
      ],
    };

    const response = await fetch(`${INWORLD_BASE_URL}/voices/v1/voices:clone`, {
      method: "POST",
      headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await expectOk(response, "voice clone");
    const parsed: unknown = await response.json();
    return parseCloneResponse(parsed);
  }

  // Nothing to tear down — Inworld has no local state.
  async dispose(): Promise<void> {}

  capabilities(): TtsBackendCapabilities {
    // Static: Inworld always supports cloning (IVC).
    return {
      supportsCloning: true,
      formats: [...CLONE_FORMATS],
      maxSizeMb: CLONE_MAX_SIZE_MB,
    };
  }
}

// ─── Response parsing (unknown at the fetch edge) ────────────────────────────

function parseAudioContent(parsed: unknown): string {
  if (typeof parsed !== "object" || parsed === null) {
    throw new InworldTtsError("Inworld /tts/v1/voice returned a non-object payload.");
  }
  const root = parsed as Record<string, unknown>;
  if (typeof root.audioContent !== "string" || root.audioContent.length === 0) {
    throw new InworldTtsError("Inworld /tts/v1/voice response is missing 'audioContent'.");
  }
  return root.audioContent;
}

interface ParsedInworldVoice {
  voiceId: string;
  displayName?: string;
  langCode?: string;
  source?: string;
}

function isParsedVoice(value: unknown): value is ParsedInworldVoice {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.voiceId !== "string" || entry.voiceId.length === 0) return false;
  if (entry.displayName !== undefined && typeof entry.displayName !== "string") return false;
  if (entry.langCode !== undefined && typeof entry.langCode !== "string") return false;
  if (entry.source !== undefined && typeof entry.source !== "string") return false;
  return true;
}

/** EN_US → en-US (BCP-47: language lowercase, region uppercase) for compact labels. */
function prettyLangCode(langCode: string): string {
  const parts = langCode.split("_");
  if (parts.length !== 2) return langCode.toLowerCase();
  return `${parts[0]!.toLowerCase()}-${parts[1]!.toUpperCase()}`;
}

/** Label convention follows the other native adapters: `name · language`,
 *  plus `· mine` for workspace-owned voices (source IVC = clone/designed,
 *  PVC = professional clone) so they stand out among SYSTEM built-ins. */
function toVoiceInfo(entry: ParsedInworldVoice): TtsVoiceInfo {
  const lang = entry.langCode ? prettyLangCode(entry.langCode) : "multi";
  const owned = entry.source === "IVC" || entry.source === "PVC";
  const suffix = owned ? " · mine" : "";
  return {
    id: entry.voiceId,
    label: `${entry.displayName ?? entry.voiceId} · ${lang}${suffix}`,
    lang,
  };
}

export function parseVoicesPage(parsed: unknown): { voices: TtsVoiceInfo[]; nextPageToken: string } {
  if (typeof parsed !== "object" || parsed === null) {
    throw new InworldTtsError("Inworld /voices/v1/voices returned a non-object payload.");
  }
  const root = parsed as Record<string, unknown>;
  const rawVoices = root.voices;
  if (!Array.isArray(rawVoices)) {
    throw new InworldTtsError("Inworld /voices/v1/voices response is missing the 'voices' array.");
  }
  const voices = rawVoices.filter(isParsedVoice).map(toVoiceInfo);
  const nextPageToken = typeof root.nextPageToken === "string" ? root.nextPageToken : "";
  return { voices, nextPageToken };
}

function parseCloneResponse(parsed: unknown): TtsVoiceInfo {
  if (typeof parsed !== "object" || parsed === null) {
    throw new InworldTtsError("Inworld voices:clone returned a non-object payload.");
  }
  const root = parsed as Record<string, unknown>;
  const voice = root.voice;
  if (typeof voice !== "object" || voice === null || typeof (voice as Record<string, unknown>).voiceId !== "string") {
    throw new InworldTtsError("Inworld voices:clone response is missing voice.voiceId.");
  }
  const entry = voice as Record<string, unknown>;
  const voiceId = entry.voiceId as string;
  const displayName = typeof entry.displayName === "string" ? entry.displayName : voiceId;
  const lang = typeof entry.langCode === "string" ? prettyLangCode(entry.langCode) : "multi";
  return { id: voiceId, label: `${displayName} · ${lang} · mine`, lang };
}

// ─── Registry wiring ─────────────────────────────────────────────────────────

export const inworldTtsFactory: TtsBackendFactory = (config: TtsProfileConfig) =>
  new InworldTtsBackend(config);

// Module-scope registration (protocol-registry pattern): importing this
// adapter makes the 'inworld' slug creatable via the registry.
registerTtsBackend(TTS_BACKEND.Inworld, inworldTtsFactory);
