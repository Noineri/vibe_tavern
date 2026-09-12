/**
 * Azure Speech TTS backend (TPE-12).
 *
 * API facts below were verified 2026-09-02 against Microsoft Learn
 * (Speech service "Text to speech API reference (REST)", live-fetched):
 * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
 * - Synthesis: POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
 *   with an SSML body. Required headers: auth, `Content-Type:
 *   application/ssml+xml`, `X-Microsoft-OutputFormat`, `User-Agent`
 *   (application name, <255 chars — REQUIRED per the docs' header table;
 *   SillyTavern's server reference omits it only because node-fetch
 *   injects a default User-Agent, which Bun's fetch does not).
 * - Auth: `Ocp-Apim-Subscription-Key: <resource key>` works directly for
 *   both synthesis and the voice list; the Bearer/issueToken flow is an
 *   optional dance we skip (docs: "if you receive a 401 with a Bearer
 *   token, use the subscription key instead").
 * - Voice catalog (LIVE): GET https://{region}.tts.speech.microsoft.com/
 *   cognitiveservices/voices/list → array of {ShortName, DisplayName,
 *   LocalName, Gender, Locale, LocaleName, StyleList?, SecondaryLocaleList?,
 *   RolePlayList?, SampleRateHertz, VoiceType, Status, WordsPerMinute}.
 *   The docs present the custom-domain form of this URL
 *   (…cognitiveservices.azure.com/tts/cognitiveservices/voices/list); our
 *   config model is region-based, so we use the regional-host form — the
 *   same URL SillyTavern's server proxy uses, cross-checked 2026-09-02.
 * - Voice == model: the voice id IS the ShortName (en-US-JennyNeural) —
 *   no model field anywhere (deepgram pattern).
 * - Output format: fixed `audio-24khz-96kbitrate-mono-mp3` (house mp3
 *   default) → mime audio/mpeg; 200 answers the audio file directly.
 * - Errors: 400/401/415/429/502/503 with plain-text bodies.
 * - Region is REQUIRED (no default exists): pre-fetch guards throw a
 *   clear error before any request (the unit's acceptance pin).
 * - Empty voiceId is NOT legal (Azure documents no default voice — the
 *   deepgram-style omission does not apply).
 * - Optional SSML tuning = the documented prosody trio (rate/pitch/
 *   volume), each omitted from the SSML entirely when unset.
 * - No voice cloning: Custom Neural Voice is an application-gated program
 *   (matrix round-1) — capabilities().supportsCloning stays false, which
 *   is what hides the profile editor's clone section.
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

const SYNTHESIS_PATH = "/cognitiveservices/v1";
const VOICES_PATH = "/cognitiveservices/voices/list";

/** The docs' header table marks User-Agent REQUIRED (application name,
 *  <255 chars). Bun's fetch sends none by default — set it explicitly. */
const USER_AGENT = "VibeTavern";

/** Fixed house output format (mp3 family) — see file header. */
const OUTPUT_FORMAT = "audio-24khz-96kbitrate-mono-mp3";
const OUTPUT_MIME = "audio/mpeg";

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

/** prosody rate — relative percentage, documented relative form
 *  (e.g. "+30%"); beyond −50 % the speech degrades to unintelligibility. */
const MIN_RATE_PERCENT = -50;
const MAX_RATE_PERCENT = 100;
/** prosody pitch — relative semitones ("+2st"). */
const MIN_PITCH_ST = -12;
const MAX_PITCH_ST = 12;
/** prosody volume — relative percentage ("+20%"). */
const MIN_VOLUME_PERCENT = -100;
const MAX_VOLUME_PERCENT = 100;

export class AzureTtsError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures). */
  readonly status?: number;
  constructor(message: string, options?: { status?: number }) {
    super(message);
    this.name = "AzureTtsError";
    this.status = options?.status;
  }
}

// ─── Config accessors (TtsProfileConfig is Record<string, unknown>) ─────────

interface AzureTtsConfig {
  apiKey: string;
  /** Azure region (e.g. westus) — REQUIRED, no default exists. */
  region: string;
  ratePercent?: number;
  pitchSt?: number;
  volumePercent?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseNumberField(config: TtsProfileConfig, key: string, min: number, max: number): number | undefined {
  const raw = config[key];
  return typeof raw === "number" && Number.isFinite(raw) ? clamp(raw, min, max) : undefined;
}

function parseConfig(config: TtsProfileConfig): AzureTtsConfig {
  const apiKey = config["apiKey"];
  const region = config["region"];
  return {
    apiKey: typeof apiKey === "string" ? apiKey : "",
    region: typeof region === "string" ? region.trim() : "",
    ratePercent: parseNumberField(config, "ratePercent", MIN_RATE_PERCENT, MAX_RATE_PERCENT),
    pitchSt: parseNumberField(config, "pitchSt", MIN_PITCH_ST, MAX_PITCH_ST),
    volumePercent: parseNumberField(config, "volumePercent", MIN_VOLUME_PERCENT, MAX_VOLUME_PERCENT),
  };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function authHeaders(apiKey: string): Record<string, string> {
  // The subscription-key header is the documented simplest form and works
  // against every endpoint shape (docs' own 401 fallback advice).
  return { "Ocp-Apim-Subscription-Key": apiKey };
}

function endpointUrl(region: string, path: string): string {
  return `https://${region}.tts.speech.microsoft.com${path}`;
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
  throw new AzureTtsError(
    `Azure ${operation} failed with HTTP ${response.status}: ${excerpt || "(empty body)"}`,
    { status: response.status },
  );
}

// ─── SSML construction ───────────────────────────────────────────────────────

/** SSML-escape the five predefined entities' characters that can appear in
 *  element text (`&`, `<`, `>`); the attribute values below are all
 *  generated, never user text. */
function escapeSsmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `en-US-JennyNeural` → `en-US`. The locale is part of the voice id
 *  itself (ShortName), which is why it can be derived at generate time —
 *  `zh-HK-HiuMaanNeural` style extra segments stay in the id, only the
 *  first two (language-CULTURE) feed xml:lang. */
function localeFromVoiceId(voiceId: string): string {
  const segments = voiceId.split("-");
  return segments.length >= 2 ? `${segments[0]}-${segments[1]}` : voiceId;
}

function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}%`;
}

/** Minimal `<speak><voice name>` envelope (the docs' own sample shape).
 *  The prosody wrapper is only emitted when at least one tuning value is
 *  set — an all-defaults request stays byte-identical to the docs' sample. */
export function buildSsml(text: string, voiceId: string, cfg: Pick<AzureTtsConfig, "ratePercent" | "pitchSt" | "volumePercent">): string {
  const lang = localeFromVoiceId(voiceId);
  const prosodyAttrs: string[] = [];
  if (cfg.ratePercent !== undefined) prosodyAttrs.push(`rate='${signedPercent(cfg.ratePercent)}'`);
  if (cfg.pitchSt !== undefined) prosodyAttrs.push(`pitch='${cfg.pitchSt >= 0 ? "+" : ""}${cfg.pitchSt}st'`);
  if (cfg.volumePercent !== undefined) prosodyAttrs.push(`volume='${signedPercent(cfg.volumePercent)}'`);
  const escaped = escapeSsmlText(text);
  const inner = prosodyAttrs.length > 0
    ? `<prosody ${prosodyAttrs.join(" ")}>${escaped}</prosody>`
    : escaped;
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'><voice xml:lang='${lang}' name='${voiceId}'>${inner}</voice></speak>`;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class AzureTtsBackend implements TtsBackend {
  private readonly cfg: AzureTtsConfig;

  constructor(config: TtsProfileConfig) {
    this.cfg = parseConfig(config);
  }

  private requireCredentials(): { apiKey: string; region: string } {
    if (!this.cfg.apiKey) {
      throw new AzureTtsError("Azure backend requires a non-empty apiKey in the profile config.");
    }
    // Region has no default — the acceptance pin: fail BEFORE any request.
    if (!this.cfg.region) {
      throw new AzureTtsError("Azure backend requires a non-empty region (e.g. westus) in the profile config.");
    }
    return { apiKey: this.cfg.apiKey, region: this.cfg.region };
  }

  async generate(req: TtsGenerateRequest): Promise<TtsAudioResult> {
    const { apiKey, region } = this.requireCredentials();
    const voice = req.voiceId.trim();
    // Unlike deepgram, an empty voice is NOT a documented server default —
    // it would 400 deep in SSML validation, so fail fast with a clear name.
    if (!voice) {
      throw new AzureTtsError("Azure synthesis requires a non-empty voiceId (a ShortName like en-US-JennyNeural).");
    }

    const response = await fetch(endpointUrl(region, SYNTHESIS_PATH), {
      method: "POST",
      headers: {
        ...authHeaders(apiKey),
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
        "User-Agent": USER_AGENT,
      },
      body: buildSsml(req.text, voice, this.cfg),
    });
    await expectOk(response, "text-to-speech");
    return { audio: Buffer.from(await response.arrayBuffer()), mime: OUTPUT_MIME };
  }

  async listVoices(): Promise<TtsVoiceInfo[]> {
    const { apiKey, region } = this.requireCredentials();
    const response = await fetch(endpointUrl(region, VOICES_PATH), { headers: authHeaders(apiKey) });
    await expectOk(response, "voice list");
    const parsed: unknown = await response.json();
    return parseVoicesList(parsed);
  }

  async probe(): Promise<TtsProbeResult> {
    if (!this.cfg.apiKey) return { ok: false, detail: "apiKey is required for Azure." };
    if (!this.cfg.region) return { ok: false, detail: "region is required for Azure (e.g. westus)." };
    try {
      const response = await fetch(endpointUrl(this.cfg.region, VOICES_PATH), {
        headers: authHeaders(this.cfg.apiKey),
      });
      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        return { ok: false, detail: `${response.status} ${excerpt || "(empty body)"}`.trim() };
      }
      return { ok: true, detail: "voice list reachable" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  // Nothing to tear down — Azure has no local state.
  async dispose(): Promise<void> {}

  capabilities(): TtsBackendCapabilities {
    // Custom Neural Voice is an application-gated program — not a
    // self-serve clone; supportsCloning false hides the clone section.
    return { supportsCloning: false };
  }
}

// ─── Response parsing (unknown at the fetch edge) ────────────────────────────

interface ParsedAzureVoice {
  ShortName: string;
  DisplayName?: unknown;
  LocalName?: unknown;
  Gender?: unknown;
  Locale?: unknown;
  VoiceType?: unknown;
  Status?: unknown;
}

function isParsedVoice(value: unknown): value is ParsedAzureVoice {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry["ShortName"] === "string" && entry["ShortName"].length > 0;
}

function readString(entry: ParsedAzureVoice, key: keyof ParsedAzureVoice): string | undefined {
  const raw = entry[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function toVoiceInfo(entry: ParsedAzureVoice): TtsVoiceInfo {
  const name = readString(entry, "DisplayName") ?? readString(entry, "LocalName") ?? entry.ShortName;
  const gender = readString(entry, "Gender");
  const locale = readString(entry, "Locale");
  // Neural is the baseline generation; anything newer/labeled otherwise
  // (HDVoice) gets an explicit marker so pickers never silently mix them.
  const voiceType = readString(entry, "VoiceType");
  const typeMarker = voiceType !== undefined && voiceType !== "Neural" ? ` · ${voiceType}` : "";
  const parts = [name, gender, locale].filter((part): part is string => part !== undefined);
  return {
    id: entry.ShortName,
    label: `${parts.join(" · ")}${typeMarker}`,
    lang: (locale ?? "").toLowerCase(),
  };
}

/** The live voices/list array IS the catalog — zero hardcoded roster
 *  (owner rule 2026-09-01). Deprecated voices are skipped (they are on
 *  their way out and fail synthesis); GA and Preview both surface. */
export function parseVoicesList(parsed: unknown): TtsVoiceInfo[] {
  if (!Array.isArray(parsed)) {
    throw new AzureTtsError("Azure voices/list returned a non-array payload.");
  }
  return parsed
    .filter(isParsedVoice)
    .filter((entry) => readString(entry, "Status") !== "Deprecated")
    .map(toVoiceInfo)
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ─── Registry wiring ─────────────────────────────────────────────────────────

export const azureTtsFactory: TtsBackendFactory = (config: TtsProfileConfig) => new AzureTtsBackend(config);

// Module-scope registration (protocol-registry pattern): importing this
// adapter makes the 'azure' slug creatable via the registry.
registerTtsBackend(TTS_BACKEND.Azure, azureTtsFactory);
