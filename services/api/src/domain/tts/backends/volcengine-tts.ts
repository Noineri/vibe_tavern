/**
 * Volcengine (Doubao) TTS backend (TPE-9).
 *
 * API facts below were verified 2026-09-01 against the live
 * volcengine.com endpoint-reference pages (Chinese; full verification trail
 * in the plan's execution log):
 * - Synthesis: POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
 *   (HTTP chunked JSON; docs/6561/1598757). Auth is PLAIN HEADERS:
 *   X-Api-App-Id + X-Api-Access-Key + X-Api-Resource-Id. The resource id
 *   doubles as the "model": seed-tts-1.0 / seed-tts-1.0-concurr /
 *   seed-tts-2.0 (+ legacy volc.service_type.10029/10048) for stock
 *   voices, seed-icl-1.0 / seed-icl-1.0-concurr / seed-icl-2.0 for cloned
 *   voices. Body: user.uid, req_params {text|ssml, speaker (REQUIRED),
 *   audio_params {format mp3/ogg_opus/pcm, sample_rate default 24000,
 *   emotion (per-voice), emotion_scale [1,5] default 4, speech_rate
 *   [-50,100] (0.5x..2x), loudness_rate [-50,100]}, additions
 *   {disable_markdown_filter (naming INVERTED: true = parse and STRIP
 *   markdown — good for RP text), post_process.pitch [-12,12]}}.
 *   Response = CHUNKED JSON LINES {code, message, data (base64 audio) |
 *   sentence, usage?}; the FINAL line carries code=20000000 ("ok");
 *   documented failures ride as 8-digit codes (40402003 text limit,
 *   45000000 speaker/resource permission, 55000000 server).
 * - Cloning (docs/6561/2227958): POST /api/v3/tts/voice_clone — JSON {
 *   speaker_id: "custom_speaker_id" (postpaid literal) + custom_speaker_id
 *   (user-chosen: [8,256] chars, letter first, [a-zA-Z0-9_-], no -/_ at
 *   the ends, must not collide with official voice patterns), audio:
 *   {data: base64, format} (wav/mp3/ogg/m4a/aac ≤ 10 MB), language? }.
 *   Same legacy auth pair. Cloning is ASYNC: the response status is
 *   1 Training / 2 Success / 4 Active (2|4 synthesizable) — poll
 *   /api/v3/tts/get_voice. Postpaid billing: the slot is charged at FIRST
 *   synthesis; a cloned-but-never-synthesized voice auto-deletes after
 *   7 days. Synthesizing a cloned voice requires X-Api-Resource-Id =
 *   seed-icl-* (surfaced as the clone-section hint).
 * - NO list endpoints exist for the synthesis credentials: get_voice is a
 *   single-speaker status query and the console ListSpeakers APIs are
 *   IAM-signed with console credentials (docs/6561/2535742 + sidebar).
 *   Under the owner rule (2026-09-01) that means manual voice input (the
 *   editor's manual floor) and manual model input with a docs link —
 *   listVoices() returns null and listModels() is not implemented.
 */

import { TTS_BACKEND } from "@vibe-tavern/domain";
import type { TtsProfileConfig } from "@vibe-tavern/domain";

import type {
  TtsBackend,
  TtsBackendCapabilities,
  TtsBackendFactory,
  TtsVoiceInfo,
  TtsAudioResult,
  TtsCloneRequest,
  TtsGenerateRequest,
  TtsProbeResult,
} from "../tts-backend.js";
import { registerTtsBackend } from "../tts-registry.js";

const VOLC_BASE_URL = "https://openspeech.bytedance.com";

/** Default resource id — the 2.0 character-tier model (the doc's own
 *  first-listed current-gen id; stock voices). Not a catalog: the field
 *  is manual input with a docs link, this is only the fallback when the
 *  config bag carries nothing. */
const DEFAULT_RESOURCE_ID = "seed-tts-2.0";

/** audio_params.speech_rate — documented range [-50, 100]. */
const MIN_SPEECH_RATE = -50;
const MAX_SPEECH_RATE = 100;
/** additions.post_process.pitch — documented range [-12, 12]. */
const MIN_PITCH = -12;
const MAX_PITCH = 12;
/** audio_params.emotion_scale — documented range [1, 5], default 4. */
const MIN_EMOTION_SCALE = 1;
const MAX_EMOTION_SCALE = 5;
/** Final-chunk success code (docs: "音频合成结束的成功状态码"). */
const CODE_SUCCESS_FINAL = 20000000;

/** Clone sample limits mirrored from the voice_clone page: wav/mp3/ogg/
 *  m4a/aac (pcm 24k mono exists too — not offered in the picker), ≤10 MB. */
const CLONE_FORMATS = ["wav", "mp3", "ogg", "m4a", "aac"];
const CLONE_MAX_SIZE_MB = 10;

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

/** Auth-failure signatures in non-200 bodies (documented messages from
 *  the common-errors section — "authenticate request: load grant:",
 *  "get resource id: access denied"). Used by probe() to separate
 *  "credentials rejected" from "service answered". */
const AUTH_FAILURE_MARKERS = ["authenticate", "access denied", "grant not found"];

export class VolcengineTtsError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for in-band code failures inside the chunk stream). */
  readonly status?: number;
  constructor(message: string, options?: { status?: number }) {
    super(message);
    this.name = "VolcengineTtsError";
    this.status = options?.status;
  }
}

// ─── Config accessors (TtsProfileConfig is Record<string, unknown>) ─────────

interface VolcengineTtsConfig {
  /** X-Api-Access-Key — the typed apiKey column, injected server-side. */
  apiKey: string;
  /** X-Api-App-Id — a non-secret console id, config-bag owned. */
  appId: string;
  /** X-Api-Resource-Id — doubles as the model (seed-tts-* / seed-icl-*). */
  resourceId: string;
  /** audio_params.speech_rate [-50,100]. */
  speechRate?: number;
  /** additions.post_process.pitch [-12,12]. */
  pitch?: number;
  /** audio_params.emotion (per-voice enum string — free input, the docs
   *  voice roster page is the source). */
  emotion?: string;
  /** audio_params.emotion_scale [1,5]. */
  emotionScale?: number;
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

export function parseVolcengineConfig(config: TtsProfileConfig): VolcengineTtsConfig {
  const speechRate = readNumber(config, "speechRate");
  const pitch = readNumber(config, "pitch");
  const emotionScale = readNumber(config, "emotionScale");
  return {
    apiKey: readString(config, "apiKey") ?? "",
    appId: readString(config, "appId") ?? "",
    resourceId: readString(config, "modelId") ?? DEFAULT_RESOURCE_ID,
    speechRate: speechRate === undefined ? undefined : clamp(speechRate, MIN_SPEECH_RATE, MAX_SPEECH_RATE),
    pitch: pitch === undefined ? undefined : Math.round(clamp(pitch, MIN_PITCH, MAX_PITCH)),
    emotion: readString(config, "emotion"),
    emotionScale:
      emotionScale === undefined ? undefined : clamp(emotionScale, MIN_EMOTION_SCALE, MAX_EMOTION_SCALE),
  };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function authHeaders(cfg: VolcengineTtsConfig): Record<string, string> {
  // Legacy-console triple — documented for synthesis AND accepted by the
  // clone/status endpoints (the new console's X-Api-Key covers only the
  // latter two, so the pair is the one credential set that works everywhere).
  return {
    "X-Api-App-Id": cfg.appId,
    "X-Api-Access-Key": cfg.apiKey,
    "X-Api-Resource-Id": cfg.resourceId,
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
  throw new VolcengineTtsError(
    `Volcengine ${operation} failed with HTTP ${response.status}: ${excerpt || "(empty body)"}`,
    { status: response.status },
  );
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class VolcengineTtsBackend implements TtsBackend {
  private readonly cfg: VolcengineTtsConfig;

  constructor(config: TtsProfileConfig) {
    this.cfg = parseVolcengineConfig(config);
  }

  private requireCredentials(): void {
    if (!this.cfg.appId || !this.cfg.apiKey) {
      throw new VolcengineTtsError(
        "Volcengine backend requires a non-empty appId and apiKey (access key) in the profile config.",
      );
    }
  }

  async generate(req: TtsGenerateRequest): Promise<TtsAudioResult> {
    this.requireCredentials();
    const speaker = req.voiceId.trim();
    if (!speaker) {
      throw new VolcengineTtsError("Volcengine generate requires a non-empty voiceId (speaker).");
    }

    const audioParams: Record<string, unknown> = { format: "mp3", sample_rate: 24000 };
    if (this.cfg.speechRate !== undefined) audioParams.speech_rate = this.cfg.speechRate;
    if (this.cfg.emotion !== undefined) audioParams.emotion = this.cfg.emotion;
    if (this.cfg.emotionScale !== undefined) audioParams.emotion_scale = this.cfg.emotionScale;

    const additions: Record<string, unknown> = {
      // Naming is inverted in the API: true = parse and STRIP markdown
      // (`**hi**` reads as "hi", not "star hi star") — the right default
      // for RP message text.
      disable_markdown_filter: true,
    };
    if (this.cfg.pitch !== undefined) additions.post_process = { pitch: this.cfg.pitch };

    const body: Record<string, unknown> = {
      user: { uid: "vibe-tavern" },
      req_params: {
        text: req.text,
        speaker,
        audio_params: audioParams,
        additions,
      },
    };

    const response = await fetch(`${VOLC_BASE_URL}/api/v3/tts/unidirectional`, {
      method: "POST",
      headers: { ...authHeaders(this.cfg), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await expectOk(response, "text-to-speech");
    return parseUnidirectionalChunks(await response.text());
  }

  async listVoices(): Promise<TtsVoiceInfo[] | null> {
    // No list endpoint exists for the synthesis credentials (see module
    // doc) — the manual floor. Null = "manual input", per the shared
    // editor contract; NEVER a static roster (owner rule 2026-09-01).
    return null;
  }

  async probe(): Promise<TtsProbeResult> {
    if (!this.cfg.appId || !this.cfg.apiKey) {
      return { ok: false, detail: "appId and apiKey (access key) are required for Volcengine." };
    }
    try {
      // get_voice is the only cheap authenticated call that needs no
      // billed synthesis. A made-up speaker id proves reachability AND
      // that the auth layer accepted the credentials (auth failures are
      // reported with their own messages — see AUTH_FAILURE_MARKERS);
      // "speaker not found" means the service answered, which is a PASS.
      const response = await fetch(`${VOLC_BASE_URL}/api/v3/tts/get_voice`, {
        method: "POST",
        headers: {
          "X-Api-App-Id": this.cfg.appId,
          "X-Api-Access-Key": this.cfg.apiKey,
          "X-Api-Request-Id": crypto.randomUUID(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ speaker_id: "vt-probe-nonexistent" }),
      });
      const text = await response.text();
      if (!response.ok && AUTH_FAILURE_MARKERS.some((m) => text.toLowerCase().includes(m))) {
        return { ok: false, detail: `${response.status} ${text.slice(0, ERROR_BODY_EXCERPT_LENGTH)}`.trim() };
      }
      return { ok: true, detail: "service reachable (voice query answered)" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async cloneVoice(req: TtsCloneRequest): Promise<TtsVoiceInfo> {
    this.requireCredentials();

    const format = cloneFormatFor(req.mimeType);
    const body: Record<string, unknown> = {
      // Postpaid path: no slot pre-order; the slot is charged at FIRST
      // synthesis (documented) — surfaced in the editor's clone hint.
      speaker_id: "custom_speaker_id",
      custom_speaker_id: buildCustomSpeakerId(req.name),
      audio: {
        data: Buffer.from(req.referenceAudio).toString("base64"),
        format,
      },
    };

    const response = await fetch(`${VOLC_BASE_URL}/api/v3/tts/voice_clone`, {
      method: "POST",
      headers: {
        "X-Api-App-Id": this.cfg.appId,
        "X-Api-Access-Key": this.cfg.apiKey,
        "X-Api-Request-Id": crypto.randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    await expectOk(response, "voice clone");
    const parsed: unknown = await response.json().catch(() => null);
    const root = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const status = root.status;
    const customId = typeof root.speaker_id === "string" ? root.speaker_id : "";
    // The wire id for a postpaid clone is the custom_speaker_id we chose
    // (the response echoes it via speaker_id on success). Training (1) is
    // the expected async outcome — the label says so; the voice becomes
    // synthesizable at status 2/4 and requires resourceId seed-icl-*.
    const id = customId.length > 0 ? customId : (body.custom_speaker_id as string);
    const training = status === 1;
    return {
      id,
      label: `${req.name} · mine${training ? " · training" : ""}`,
      lang: "clone",
    };
  }

  // Nothing to tear down — Volcengine has no local state.
  async dispose(): Promise<void> {}

  capabilities(): TtsBackendCapabilities {
    return {
      supportsCloning: true,
      formats: [...CLONE_FORMATS],
      maxSizeMb: CLONE_MAX_SIZE_MB,
    };
  }
}

// ─── Response parsing (unknown at the fetch edge) ────────────────────────────

/** Parse the chunked-JSON-lines body of the unidirectional endpoint:
 *  each line is `{code, message, data?, sentence?, usage?}`; base64
 *  `data` chunks concatenate into the clip; the FINAL line carries
 *  code=20000000. Any other non-zero code is a failure. Exported for
 *  tests. */
export function parseUnidirectionalChunks(body: string): TtsAudioResult {
  const chunks: Buffer[] = [];
  let sawFinalOk = false;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Partial/trailing garbage inside the stream — tolerated only when
      // the final ok line already arrived (server keep-alive noise).
      if (sawFinalOk) continue;
      throw new VolcengineTtsError(`Volcengine text-to-speech returned an unparseable chunk: ${line.slice(0, 120)}`);
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const root = parsed as Record<string, unknown>;
    const code = root.code;
    if (typeof code !== "number") continue;
    if (code === CODE_SUCCESS_FINAL) {
      sawFinalOk = true;
      continue;
    }
    if (code !== 0) {
      const message = typeof root.message === "string" ? root.message : "(no message)";
      throw new VolcengineTtsError(`Volcengine text-to-speech failed with code ${code}: ${message}`);
    }
    if (typeof root.data === "string" && root.data.length > 0) {
      chunks.push(Buffer.from(root.data, "base64"));
    }
  }
  if (!sawFinalOk) {
    throw new VolcengineTtsError("Volcengine text-to-speech stream ended without the success code 20000000.");
  }
  if (chunks.length === 0) {
    throw new VolcengineTtsError("Volcengine text-to-speech response contained no audio data.");
  }
  return { audio: Buffer.concat(chunks), mime: "audio/mpeg" };
}

/** mime → audio.format for the clone payload (wav/mp3/ogg/m4a/aac — the
 *  five picker-offered formats; pcm stays unoffered). */
function cloneFormatFor(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("wav")) return "wav";
  if (lower.includes("ogg")) return "ogg";
  if (lower.includes("m4a")) return "m4a";
  if (lower.includes("aac")) return "aac";
  return "mp3";
}

/** Build a custom_speaker_id from the user's name, honoring every
 *  documented rule: [8,256] chars, first char an English letter,
 *  letters/digits/-/_ only, no -/_ at either end, and no collision with
 *  the official voice-id patterns (S_|ICL_|MIX_|DiT_|BV|<lang>_ prefixes,
 *  *_bigtts suffixes) — the vt- prefix plus alnum tail satisfies all of
 *  them without a lookup. */
export function buildCustomSpeakerId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const base = `vt-${slug.length > 0 ? `${slug}-` : ""}`;
  let suffix = "";
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const timePart = Date.now().toString(36);
  for (let i = 0; i < 4; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  const id = `${base}${timePart}${suffix}`.slice(0, 256);
  return id.length >= 8 ? id : `${id}0000000000`.slice(0, 8);
}

// ─── Registry wiring ─────────────────────────────────────────────────────────

export const volcengineTtsFactory: TtsBackendFactory = (config: TtsProfileConfig) =>
  new VolcengineTtsBackend(config);

// Module-scope registration (protocol-registry pattern): importing this
// adapter makes the 'volcengine' slug creatable via the registry.
registerTtsBackend(TTS_BACKEND.Volcengine, volcengineTtsFactory);
