/**
 * MiniMax TTS backend (TPE-7).
 *
 * API facts below were verified 2026-08-31 against the live
 * platform.minimax.io endpoint-reference pages (international API):
 * - Base URL https://api.minimax.io; auth is `Authorization: Bearer
 *   <key>`. (An alternative low-latency host api-uw.minimax.io exists —
 *   not used, the primary host is the default.)
 * - POST /v1/t2a_v2 — JSON body: model (enum speech-2.8-hd/turbo,
 *   2.6-hd/turbo, 02-hd/turbo, 01-hd/turbo), text (≤10,000 chars;
 *   pause markers `<#x#>`; interjection tags on 2.8 models only), stream
 *   (false default), language_boost (enum incl. `auto` — default null =
 *   auto-detect), output_format (`hex` default | `url`, url valid 24 h),
 *   voice_setting {voice_id, speed, vol, pitch}, audio_setting
 *   {sample_rate 32000, bitrate 128000, format mp3, channel 1},
 *   pronunciation_dict, voice_modify. Response is JSON with data.audio =
 *   HEX-ENCODED audio (not base64, not raw bytes!), extra_info
 *   (audio_format mp3), trace_id, and base_resp {status_code 0 =
 *   success} — MiniMax reports failures via base_resp INSIDE HTTP 200,
 *   so every response is checked for status_code !== 0 too.
 * - Speed/vol/pitch documented ranges: speed [0.5, 2] (default 1), vol
 *   (0, 10] (default 1), pitch int [-12, 12] (default 0). v1 exposes
 *   speed only.
 * - POST /v1/get_voice {voice_type} — system | voice_cloning |
 *   voice_generation (the page's own example uses `all`). Response:
 *   {system_voice?: [{voice_id, description: string[], voice_name,
 *   created_time}], voice_cloning?: [...], voice_generation?: [...],
 *   base_resp}. Caveat from the schema: cloned voices appear in the list
 *   only after they have been successfully used for a synthesis.
 * - POST /v1/files/upload — multipart: purpose="voice_clone", file
 *   binary. mp3/m4a/wav, 10 s – 5 min, ≤ 20 MB. Response {file: {file_id
 *   (number), bytes, created_at, filename, purpose}, base_resp}.
 * - POST /v1/voice_clone — JSON (the SECOND step): {file_id, voice_id
 *   (USER-CHOSEN unique id: length [8,256], must start with an English
 *   letter, letters/digits/-/_ only, must not end with - or _, must not
 *   duplicate an existing voice_id), text? + model? (preview — charged),
 *   text_validation?/accuracy?/need_noise_reduction?/...}. Response:
 *   {input_sensitive, demo_audio, extra_info?, base_resp} — success is
 *   base_resp.status_code === 0; the voice id is the one WE chose.
 *   DOCUMENTED CAVEAT: a cloned voice not used within 7 days is deleted
 *   by the system (surfaced in the editor's clone section).
 * - Interjection tags (speech-2.8-hd/turbo only, from both the t2a and
 *   voice_clone pages): (laughs), (chuckle) — singular in their list —,
 *   (coughs), (clear-throat), (groans), (breath), (pant), (inhale),
 *   (exhale), (gasps), (sniffs), (sighs), (snorts), (burps),
 *   (lip-smacking), (humming), (hissing), (emm), (whistles), (sneezes),
 *   (crying), (applause). Maps 7 of our 8 canonical annotation tags.
 * - Endpoint-path discrepancy logged: the context7 snapshot titled the
 *   sync endpoint "POST /v2/t2a", but the live page's own curl targets
 *   https://api.minimax.io/v1/t2a_v2 (twice) — endpoint reference wins.
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

const MINIMAX_BASE_URL = "https://api.minimax.io";

const DEFAULT_MODEL_ID = "speech-2.8-hd";

/** Static documented model catalog — the t2a page's model enum (no
 *  list-models endpoint exists). */
const DOCUMENTED_MODELS: TtsModelInfo[] = [
  { id: "speech-2.8-hd", label: "speech-2.8-hd · latest flagship" },
  { id: "speech-2.8-turbo", label: "speech-2.8-turbo · latest fast" },
  { id: "speech-2.6-hd", label: "speech-2.6-hd" },
  { id: "speech-2.6-turbo", label: "speech-2.6-turbo" },
  { id: "speech-02-hd", label: "speech-02-hd" },
  { id: "speech-02-turbo", label: "speech-02-turbo" },
  { id: "speech-01-hd", label: "speech-01-hd · legacy" },
  { id: "speech-01-turbo", label: "speech-01-turbo · legacy" },
];

/** voice_setting.speed — documented range [0.5, 2]. */
const MIN_SPEED = 0.5;
const MAX_SPEED = 2;

/** Clone sample limits mirrored from the files/upload page: mp3/m4a/wav,
 *  10 s – 5 min, ≤ 20 MB. */
const CLONE_FORMATS = ["mp3", "m4a", "wav"];
const CLONE_MAX_SIZE_MB = 20;

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

export class MinimaxTtsError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for base_resp-level failures inside HTTP 200). */
  readonly status?: number;
  constructor(message: string, options?: { status?: number }) {
    super(message);
    this.name = "MinimaxTtsError";
    this.status = options?.status;
  }
}

// ─── Config accessors (TtsProfileConfig is Record<string, unknown>) ─────────

interface MinimaxTtsConfig {
  apiKey: string;
  modelId: string;
  /** voice_setting.speed — clamped to the documented [0.5, 2]. */
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

function parseConfig(config: TtsProfileConfig): MinimaxTtsConfig {
  const speed = readNumber(config, "speed");
  return {
    apiKey: readString(config, "apiKey") ?? "",
    modelId: readString(config, "modelId") ?? DEFAULT_MODEL_ID,
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
  throw new MinimaxTtsError(
    `MiniMax ${operation} failed with HTTP ${response.status}: ${excerpt || "(empty body)"}`,
    { status: response.status },
  );
}

/** Parse a JSON body and enforce MiniMax's in-band status: failures ride
 *  as base_resp.status_code !== 0 INSIDE HTTP 200. */
async function parseJsonWithBaseResp(response: Response, operation: string): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  if (typeof parsed !== "object" || parsed === null) {
    throw new MinimaxTtsError(`MiniMax ${operation} returned a non-object payload.`);
  }
  const root = parsed as Record<string, unknown>;
  const baseResp = root.base_resp;
  if (typeof baseResp === "object" && baseResp !== null) {
    const statusCode = (baseResp as Record<string, unknown>).status_code;
    const statusMsg = (baseResp as Record<string, unknown>).status_msg;
    if (typeof statusCode === "number" && statusCode !== 0) {
      throw new MinimaxTtsError(
        `MiniMax ${operation} failed with status ${statusCode}: ${
          typeof statusMsg === "string" ? statusMsg : "(no message)"
        }`,
      );
    }
  }
  return root;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class MinimaxTtsBackend implements TtsBackend {
  private readonly cfg: MinimaxTtsConfig;

  constructor(config: TtsProfileConfig) {
    this.cfg = parseConfig(config);
  }

  private requireApiKey(): string {
    if (!this.cfg.apiKey) {
      throw new MinimaxTtsError("MiniMax backend requires a non-empty apiKey in the profile config.");
    }
    return this.cfg.apiKey;
  }

  async generate(req: TtsGenerateRequest): Promise<TtsAudioResult> {
    const apiKey = this.requireApiKey();
    const voiceId = req.voiceId.trim();
    if (!voiceId) {
      throw new MinimaxTtsError("MiniMax generate requires a non-empty voiceId.");
    }

    const voiceSetting: Record<string, unknown> = { voice_id: voiceId };
    // voice_setting.speed — config-owned (req.speed is a transient
    // playback hint), same contract as the other native adapters.
    if (this.cfg.speed !== undefined) voiceSetting.speed = this.cfg.speed;

    const body: Record<string, unknown> = {
      model: this.cfg.modelId,
      text: req.text,
      stream: false,
      // hex is the documented default; stating it keeps the decode honest.
      output_format: "hex",
      voice_setting: voiceSetting,
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    };

    const response = await fetch(`${MINIMAX_BASE_URL}/v1/t2a_v2`, {
      method: "POST",
      headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await expectOk(response, "text-to-speech");
    const root = await parseJsonWithBaseResp(response, "text-to-speech");
    const data = root.data;
    if (typeof data !== "object" || data === null || typeof (data as Record<string, unknown>).audio !== "string") {
      throw new MinimaxTtsError("MiniMax t2a response is missing data.audio.");
    }
    // data.audio is HEX-encoded mp3 (not base64, not raw bytes).
    return { audio: Buffer.from((data as Record<string, unknown>).audio as string, "hex"), mime: "audio/mpeg" };
  }

  async listVoices(): Promise<TtsVoiceInfo[]> {
    this.requireApiKey();
    const response = await fetch(`${MINIMAX_BASE_URL}/v1/get_voice`, {
      method: "POST",
      headers: { ...authHeaders(this.cfg.apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({ voice_type: "all" }),
    });
    await expectOk(response, "voice list");
    const root = await parseJsonWithBaseResp(response, "voice list");
    return parseGetVoiceResponse(root);
  }

  async listModels(): Promise<TtsModelInfo[]> {
    // Static documented catalog — no network call, no key needed.
    return [...DOCUMENTED_MODELS];
  }

  async probe(): Promise<TtsProbeResult> {
    if (!this.cfg.apiKey) {
      return { ok: false, detail: "apiKey is required for MiniMax." };
    }
    try {
      const response = await fetch(`${MINIMAX_BASE_URL}/v1/get_voice`, {
        method: "POST",
        headers: { ...authHeaders(this.cfg.apiKey), "Content-Type": "application/json" },
        body: JSON.stringify({ voice_type: "voice_cloning" }),
      });
      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        return { ok: false, detail: `${response.status} ${excerpt || "(empty body)"}`.trim() };
      }
      // base_resp-level failures also ride inside HTTP 200 — honor them.
      await parseJsonWithBaseResp(response, "probe");
      return { ok: true, detail: "voice list reachable" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async cloneVoice(req: TtsCloneRequest): Promise<TtsVoiceInfo> {
    const apiKey = this.requireApiKey();

    // Step 1/2 — upload the sample (multipart: purpose=voice_clone + file).
    const extension = mimeTypeExtension(req.mimeType);
    const form = new FormData();
    form.append("purpose", "voice_clone");
    form.append(
      "file",
      new Blob([new Uint8Array(req.referenceAudio)], { type: req.mimeType }),
      `clip.${extension}`,
    );
    const uploadResponse = await fetch(`${MINIMAX_BASE_URL}/v1/files/upload`, {
      method: "POST",
      headers: authHeaders(apiKey),
      // No Content-Type — fetch derives the multipart boundary itself.
      body: form,
    });
    await expectOk(uploadResponse, "file upload");
    const uploadRoot = await parseJsonWithBaseResp(uploadResponse, "file upload");
    const file = uploadRoot.file;
    const fileId =
      typeof file === "object" && file !== null ? (file as Record<string, unknown>).file_id : undefined;
    if (typeof fileId !== "number") {
      throw new MinimaxTtsError("MiniMax file upload response is missing file.file_id.");
    }

    // Step 2/2 — clone from the uploaded file. voice_id is OUR choice and
    // must be unique, [8,256] chars, start with a letter, letters/digits/
    // -/_ only, not end with -/_ — the generated id satisfies all of it.
    const voiceId = buildCloneVoiceId(req.name);
    const cloneResponse = await fetch(`${MINIMAX_BASE_URL}/v1/voice_clone`, {
      method: "POST",
      headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
      // No preview text (charged); no ASR validation fields in v1.
      body: JSON.stringify({ file_id: fileId, voice_id: voiceId }),
    });
    await expectOk(cloneResponse, "voice clone");
    await parseJsonWithBaseResp(cloneResponse, "voice clone");
    return { id: voiceId, label: `${req.name} · mine`, lang: "clone" };
  }

  // Nothing to tear down — MiniMax has no local state.
  async dispose(): Promise<void> {}

  capabilities(): TtsBackendCapabilities {
    // Static: MiniMax always supports two-step cloning.
    return {
      supportsCloning: true,
      formats: [...CLONE_FORMATS],
      maxSizeMb: CLONE_MAX_SIZE_MB,
    };
  }
}

// ─── Response parsing (unknown at the fetch edge) ────────────────────────────

function isParsedVoiceEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toVoiceInfo(entry: Record<string, unknown>, mine: boolean): TtsVoiceInfo | null {
  const voiceId = entry.voice_id;
  if (typeof voiceId !== "string" || voiceId.length === 0) return null;
  const voiceName = typeof entry.voice_name === "string" ? entry.voice_name : undefined;
  // description is a string[] — the first sentence is the display blurb.
  const rawDescription = entry.description;
  let description: string | undefined;
  if (Array.isArray(rawDescription)) {
    const first = rawDescription.find((d): d is string => typeof d === "string" && d.length > 0);
    description = first;
  }
  const name = voiceName ?? voiceId;
  const suffix = description ? ` · ${description}` : "";
  return { id: voiceId, label: `${name}${suffix}${mine ? " · mine" : ""}`, lang: "multi" };
}

/** get_voice: {system_voice?: [...], voice_cloning?: [...], voice_generation?
 *  [...]} — clones ARE usable for synthesis, so both clone sections ride
 *  along tagged "mine". Cloned voices only appear after their first
 *  successful synthesis (documented) — a just-cloned voice still works
 *  by typing/selecting the returned id. */
export function parseGetVoiceResponse(root: Record<string, unknown>): TtsVoiceInfo[] {
  const out: TtsVoiceInfo[] = [];
  const systemVoices = Array.isArray(root.system_voice) ? root.system_voice : [];
  for (const entry of systemVoices) {
    if (!isParsedVoiceEntry(entry)) continue;
    const info = toVoiceInfo(entry, false);
    if (info) out.push(info);
  }
  for (const key of ["voice_cloning", "voice_generation"] as const) {
    const voices = Array.isArray(root[key]) ? root[key] : [];
    for (const entry of voices) {
      if (!isParsedVoiceEntry(entry)) continue;
      const info = toVoiceInfo(entry, true);
      if (info) out.push(info);
    }
  }
  return out;
}

/** mime → extension for the multipart filename (MiniMax accepts
 *  mp3/m4a/wav samples). */
function mimeTypeExtension(mimeType: string): string {
  if (mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("wav")) return "wav";
  return "mp3";
}

/** Build a clone voice_id from the user's name, honoring every documented
 *  rule: [8,256] chars, starts with an English letter, letters/digits/-/_
 *  only, must not end with - or _; the random suffix guarantees the
 *  "must not duplicate an existing voice_id" rule without a lookup. */
export function buildCloneVoiceId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const base = `vt-${slug.length > 0 ? `${slug}-` : ""}`;
  let suffix = "";
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  // Deterministic-enough uniqueness without extra state: timestamp base36
  // + a small random tail, always ending alnum.
  const timePart = Date.now().toString(36);
  for (let i = 0; i < 4; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  const id = `${base}${timePart}${suffix}`.slice(0, 256);
  // Minimum length 8 — pad with alnum if the name was empty.
  return id.length >= 8 ? id : `${id}0000000000`.slice(0, 8);
}

// ─── Registry wiring ─────────────────────────────────────────────────────────

export const minimaxTtsFactory: TtsBackendFactory = (config: TtsProfileConfig) =>
  new MinimaxTtsBackend(config);

// Module-scope registration (protocol-registry pattern): importing this
// adapter makes the 'minimax' slug creatable via the registry.
registerTtsBackend(TTS_BACKEND.MiniMax, minimaxTtsFactory);
