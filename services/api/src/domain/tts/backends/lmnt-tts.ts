/**
 * LMNT TTS backend (TPE-6).
 *
 * API facts below were verified 2026-08-31 against docs.lmnt.com
 * (endpoint-reference pages, live-fetched + context7 /websites/lmnt):
 * - Base URL https://api.lmnt.com; auth is the `X-API-Key: <key>` header
 *   (OpenAPI securitySchemes: ApiKeyHeader).
 * - POST /v1/ai/speech/bytes — JSON body {voice (required, id from List
 *   voices), text (required, ≤5000 chars), model (enum — the live page
 *   lists exactly `blizzard`, the default; the retired `aurora` id still
 *   routes server-side but is not in the enum), language (enum auto/ar/
 *   de/en/es/fr/hi/id/it/ja/ko/nl/pl/pt/ru/sv/th/tr/uk/ur/vi/zh, default
 *   auto-detect), format (mp3 default, 96kbps; aac/ulaw/wav/webm/pcm_*),
 *   sample_rate (8000/16000/24000, default 24000), seed, top_p
 *   (documented range 0..1, default 0.8 — stability: lower = more
 *   consistent), temperature (documented range >= 0, default 1 —
 *   expressiveness)}. Response is the raw binary audio stream (type
 *   "file") — NOT JSON, unlike Inworld.
 * - GET /v1/ai/voice/list — returns a FLAT ARRAY (no pagination, no
 *   envelope). Voice = {id, name, owner: system|me|other, starred, state:
 *   ready|training, type: instant|professional, description?, gender?,
 *   preview_url?}. Query params starred/owner (system|me|all).
 * - POST /v1/ai/voice — voice cloning via multipart form-data (not JSON):
 *   fields name (required), enhance (boolean, required — noise cleanup,
 *   default false as it "can also degrade quality"), files (1–20 binary
 *   attachments: wav/mp3/mp4/m4a/webm; max 250 MB total), gender/
 *   description (optional, no effect on creation). Response = the created
 *   voice object (flat, like the list).
 * - Models: no list-models endpoint; the live speech page's model enum
 *   contains exactly `blizzard` (changelog: "Blizzard is now the default
 *   model… Aurora automatically routes to Blizzard"). listModels() serves
 *   this static documented catalog (F8 "documented" philosophy).
 * - Doc discrepancy logged: the Python SDK page claims language "does not
 *   work with professional clones and the blizzard model" and lists only
 *   8 languages — the live endpoint reference carries the wide enum with
 *   auto-detect and no such caveat; per house rule the endpoint-reference
 *   page wins. v1 still omits the language knob (auto-detect default).
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

const LMNT_BASE_URL = "https://api.lmnt.com";

const DEFAULT_MODEL_ID = "blizzard";

/** Static documented model catalog — the live speech page's model enum has
 *  exactly one entry (`blizzard`); aurora is a retired server-side alias
 *  and is deliberately NOT offered. */
const DOCUMENTED_MODELS: TtsModelInfo[] = [
  { id: "blizzard", label: "blizzard · default, latest" },
];

/** top_p — documented required range `0 <= x <= 1`, default 0.8. */
const MIN_TOP_P = 0;
const MAX_TOP_P = 1;

/** temperature — documented required range `x >= 0` only (no upper bound
 *  documented; docs' own examples run 0.3–1.0). Clamp below at 0 and pass
 *  the rest through; the UI's number field provides its own handrail. */
const MIN_TEMPERATURE = 0;

/** Clone sample limits mirrored from the docs: wav/mp3/mp4/m4a/webm
 *  attachments, 1–20 files, 250 MB total (we always send exactly one). */
const CLONE_FORMATS = ["wav", "mp3", "mp4", "m4a", "webm"];
const CLONE_MAX_SIZE_MB = 250;

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

/** Voices listing scope: the editor wants system built-ins AND the user's
 *  clones in one list ("all" documented owner value). */
const VOICES_OWNER = "all";

export class LmntTtsError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures). */
  readonly status?: number;
  constructor(message: string, options?: { status?: number }) {
    super(message);
    this.name = "LmntTtsError";
    this.status = options?.status;
  }
}

// ─── Config accessors (TtsProfileConfig is Record<string, unknown>) ─────────

interface LmntTtsConfig {
  apiKey: string;
  modelId: string;
  /** top_p — clamped to the documented [0, 1]. */
  topP?: number;
  /** temperature — clamped below at the documented 0. */
  temperature?: number;
}

function clamp(value: number, min: number, max?: number): number {
  let out = Math.max(min, value);
  if (max !== undefined) out = Math.min(max, out);
  return out;
}

function readString(config: TtsProfileConfig, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(config: TtsProfileConfig, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseConfig(config: TtsProfileConfig): LmntTtsConfig {
  const topP = readNumber(config, "topP");
  const temperature = readNumber(config, "temperature");
  return {
    apiKey: readString(config, "apiKey") ?? "",
    modelId: readString(config, "modelId") ?? DEFAULT_MODEL_ID,
    topP: topP === undefined ? undefined : clamp(topP, MIN_TOP_P, MAX_TOP_P),
    temperature: temperature === undefined ? undefined : clamp(temperature, MIN_TEMPERATURE),
  };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function authHeaders(apiKey: string): Record<string, string> {
  return { "X-API-Key": apiKey };
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
  throw new LmntTtsError(
    `LMNT ${operation} failed with HTTP ${response.status}: ${excerpt || "(empty body)"}`,
    { status: response.status },
  );
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class LmntTtsBackend implements TtsBackend {
  private readonly cfg: LmntTtsConfig;

  constructor(config: TtsProfileConfig) {
    this.cfg = parseConfig(config);
  }

  private requireApiKey(): string {
    if (!this.cfg.apiKey) {
      throw new LmntTtsError("LMNT backend requires a non-empty apiKey in the profile config.");
    }
    return this.cfg.apiKey;
  }

  async generate(req: TtsGenerateRequest): Promise<TtsAudioResult> {
    const apiKey = this.requireApiKey();
    const voice = req.voiceId.trim();
    if (!voice) {
      throw new LmntTtsError("LMNT generate requires a non-empty voiceId.");
    }

    const body: Record<string, unknown> = {
      voice,
      text: req.text,
      model: this.cfg.modelId,
    };
    // LMNT has NO speed parameter — the expressiveness knobs are top_p
    // (stability) and temperature (expressiveness), both config-owned
    // (req.speed is a transient playback hint and is ignored).
    if (this.cfg.topP !== undefined) body.top_p = this.cfg.topP;
    if (this.cfg.temperature !== undefined) body.temperature = this.cfg.temperature;

    // The bytes endpoint answers with the raw binary audio stream (mp3
    // default, 96kbps) — collect it via arrayBuffer, no JSON envelope.
    const response = await fetch(`${LMNT_BASE_URL}/v1/ai/speech/bytes`, {
      method: "POST",
      headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await expectOk(response, "text-to-speech");
    return { audio: Buffer.from(await response.arrayBuffer()), mime: "audio/mpeg" };
  }

  async listVoices(): Promise<TtsVoiceInfo[]> {
    this.requireApiKey();
    const url = new URL(`${LMNT_BASE_URL}/v1/ai/voice/list`);
    url.searchParams.set("owner", VOICES_OWNER);
    const response = await fetch(url, { headers: authHeaders(this.cfg.apiKey) });
    await expectOk(response, "voice list");
    const parsed: unknown = await response.json();
    return parseVoicesList(parsed);
  }

  async listModels(): Promise<TtsModelInfo[]> {
    // Static documented catalog — no network call, no key needed (there is
    // no list-models endpoint; the speech page's model enum is the source).
    return [...DOCUMENTED_MODELS];
  }

  async probe(): Promise<TtsProbeResult> {
    if (!this.cfg.apiKey) {
      return { ok: false, detail: "apiKey is required for LMNT." };
    }
    try {
      const url = new URL(`${LMNT_BASE_URL}/v1/ai/voice/list`);
      url.searchParams.set("owner", "me");
      const response = await fetch(url, { headers: authHeaders(this.cfg.apiKey) });
      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        return { ok: false, detail: `${response.status} ${excerpt || "(empty body)"}`.trim() };
      }
      return { ok: true, detail: "voice list reachable" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async cloneVoice(req: TtsCloneRequest): Promise<TtsVoiceInfo> {
    const apiKey = this.requireApiKey();
    // Multipart form-data: name + enhance (required booleans — the docs
    // default enhance to false because cleanup "can also degrade quality")
    // + the sample as a `files` attachment. The extension keys the
    // filename (LMNT sniffs wav/mp3/mp4/m4a/webm), mirroring Cartesia.
    const form = new FormData();
    form.append("name", req.name);
    form.append("enhance", "false");
    const extension = mimeTypeExtension(req.mimeType);
    form.append(
      "files",
      new Blob([new Uint8Array(req.referenceAudio)], { type: req.mimeType }),
      `clip.${extension}`,
    );

    const response = await fetch(`${LMNT_BASE_URL}/v1/ai/voice`, {
      method: "POST",
      headers: authHeaders(apiKey),
      // No Content-Type — fetch derives the multipart boundary itself.
      body: form,
    });
    await expectOk(response, "voice clone");
    const parsed: unknown = await response.json();
    return parseVoiceObject(parsed);
  }

  // Nothing to tear down — LMNT has no local state.
  async dispose(): Promise<void> {}

  capabilities(): TtsBackendCapabilities {
    // Static: LMNT always supports instant cloning; NO speed knob (the
    // tuning surface is top_p/temperature instead).
    return {
      supportsCloning: true,
      formats: [...CLONE_FORMATS],
      maxSizeMb: CLONE_MAX_SIZE_MB,
    };
  }
}

// ─── Response parsing (unknown at the fetch edge) ────────────────────────────

interface ParsedLmntVoice {
  id: string;
  name?: string;
  owner?: string;
  state?: string;
  description?: string;
  gender?: string;
}

function isParsedVoice(value: unknown): value is ParsedLmntVoice {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) return false;
  for (const key of ["name", "owner", "state", "description", "gender"] as const) {
    const v = entry[key];
    if (v !== undefined && typeof v !== "string") return false;
  }
  return true;
}

/** LMNT descriptions read like "UK. Young adult. Conversational" — the
 *  first segment is a compact origin/accent tag that plays the label role
 *  other providers' langCode plays ("UK", "Multilingual", …). */
function describeSegment(description: string | undefined): string {
  if (typeof description !== "string") return "voice";
  const first = description.split(".")[0]?.trim();
  return first && first.length > 0 ? first : "voice";
}

function toVoiceInfo(entry: ParsedLmntVoice): TtsVoiceInfo {
  const origin = describeSegment(entry.description);
  const mine = entry.owner === "me";
  const name = entry.name ?? entry.id;
  return {
    id: entry.id,
    label: `${name} · ${origin}${mine ? " · mine" : ""}`,
    lang: origin.toLowerCase(),
  };
}

function parseVoiceObject(parsed: unknown): TtsVoiceInfo {
  if (!isParsedVoice(parsed)) {
    throw new LmntTtsError("LMNT voice response is missing the 'id' field.");
  }
  // Clone responses return the created voice (owner "me"); keep the same
  // label shape the list produces so pickers render both identically.
  return toVoiceInfo({ ...parsed, owner: parsed.owner ?? "me" });
}

/** The list endpoint answers with a flat array — no envelope, no pagination. */
export function parseVoicesList(parsed: unknown): TtsVoiceInfo[] {
  if (!Array.isArray(parsed)) {
    throw new LmntTtsError("LMNT /v1/ai/voice/list returned a non-array payload.");
  }
  return parsed
    .filter(isParsedVoice)
    // Training voices cannot synthesize yet — hide them until ready so the
    // editor never offers a voice that would fail generation.
    .filter((entry) => entry.state === undefined || entry.state === "ready")
    .map(toVoiceInfo);
}

/** mime → extension for the multipart filename (LMNT sniffs the container). */
function mimeTypeExtension(mimeType: string): string {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("webm")) return "webm";
  return "mp3";
}

// ─── Registry wiring ─────────────────────────────────────────────────────────

export const lmntTtsFactory: TtsBackendFactory = (config: TtsProfileConfig) =>
  new LmntTtsBackend(config);

// Module-scope registration (protocol-registry pattern): importing this
// adapter makes the 'lmnt' slug creatable via the registry.
registerTtsBackend(TTS_BACKEND.Lmnt, lmntTtsFactory);
