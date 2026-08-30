/**
 * @module tts/backends/gemini-tts
 *
 * Native Gemini TTS adapter (TTS_PLAN TS-5) — talks to the Interactions REST
 * surface (`POST /v1beta/interactions`) with an audio response format. The TTS
 * models reject the classic `:generateContent` surface and the `@ai-sdk/google`
 * path does not model audio output, so this adapter is a raw fetch.
 *
 * Request shape verified 2026-08-27 from ai.google.dev speech-generation docs:
 * `response_format: { type: "audio" }` + `generation_config.speech_config:
 * [{ voice }]`; the key travels in the `x-goog-api-key` header (an
 * `Authorization: Bearer` header is rejected with API_KEY_SERVICE_BLOCKED on
 * this API). Style control is natural language: `instructions` is folded into
 * the input as a "director's notes" preamble — a clear preamble also reduces
 * PROHIBITED_CONTENT classifier false rejections (docs limitation note).
 *
 * The raw REST audio part shape is not fully pinned by the docs (the SDK's
 * convenience property `interaction.output_audio` hides it), so audio
 * extraction is a defensive recursive scan over known containers (`output`,
 * `candidates`, and `steps` — the last being the shape the repo's own
 * interactions chat parsing reads) — see {@link findAudioBlock}. Live
 * verification against the owner's free key is pending.
 */

import { TTS_BACKEND } from "@vibe-tavern/domain";
import type { TtsProfileConfig } from "@vibe-tavern/domain";

import type {
  TtsAudioResult,
  TtsBackend,
  TtsBackendCapabilities,
  TtsBackendFactory,
  TtsGenerateRequest,
  TtsProbeResult,
  TtsVoiceInfo,
} from "../tts-backend.js";
import { registerTtsBackend } from "../tts-registry.js";

const INTERACTIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash-preview-tts";
const DEFAULT_VOICE = "Kore";
const DEFAULT_SAMPLE_RATE = 24000;

export class GeminiTtsError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures). */
  readonly status?: number;
  constructor(message: string, options?: { status?: number }) {
    super(message);
    this.name = "GeminiTtsError";
    this.status = options?.status;
  }
}

// ─── Prebuilt voice catalog (verified 2026-08-27, docs 30-voice table) ──────
//
// Voices are language-neutral: the model auto-detects the input language, so
// `lang` is the constant "multi" (the UI filters English-first journeys by
// profile choice, not by this catalog).

const GEMINI_VOICE_SPECS = [
  ["Zephyr", "Bright"],
  ["Puck", "Upbeat"],
  ["Charon", "Informative"],
  ["Kore", "Firm"],
  ["Fenrir", "Excitable"],
  ["Leda", "Youthful"],
  ["Orus", "Firm"],
  ["Aoede", "Breezy"],
  ["Callirrhoe", "Easy-going"],
  ["Autonoe", "Bright"],
  ["Enceladus", "Breathy"],
  ["Iapetus", "Clear"],
  ["Umbriel", "Easy-going"],
  ["Algieba", "Smooth"],
  ["Despina", "Smooth"],
  ["Erinome", "Clear"],
  ["Algenib", "Gravelly"],
  ["Rasalgethi", "Informative"],
  ["Laomedeia", "Upbeat"],
  ["Achernar", "Soft"],
  ["Alnilam", "Firm"],
  ["Schedar", "Even"],
  ["Gacrux", "Mature"],
  ["Pulcherrima", "Forward"],
  ["Achird", "Friendly"],
  ["Zubenelgenubi", "Casual"],
  ["Vindemiatrix", "Gentle"],
  ["Sadachbia", "Lively"],
  ["Sadaltager", "Knowledgeable"],
  ["Sulafat", "Warm"],
] as const;

export const GEMINI_TTS_VOICES: readonly TtsVoiceInfo[] = GEMINI_VOICE_SPECS.map(
  ([id, descriptor]) => ({
    id,
    label: `${id} (${descriptor})`,
    lang: "multi",
  }),
);

/** Editor hint for TS-7's tier-gated panel (free-tier quota). */
export const GEMINI_TTS_FREE_TIER_HINT =
  "Free tier: ~500 requests/day (shared across 2.5 Flash / Flash-Lite TTS; Pro TTS is paid-only)";

// ─── PCM → WAV (pure) ────────────────────────────────────────────────────────

/**
 * Wrap 16-bit signed little-endian mono PCM in a 44-byte RIFF/WAVE header.
 * Exported so tests can pin the header layout without a decoder.
 */
export function pcmToWav(pcm: Buffer, sampleRate = DEFAULT_SAMPLE_RATE): Buffer {
  const dataLen = pcm.length;
  const wav = Buffer.alloc(44 + dataLen);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataLen, 4); // RIFF chunk size
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  wav.writeUInt16LE(1, 20); // audio format: 1 = PCM
  wav.writeUInt16LE(1, 22); // channels: 1 = mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); // byte rate (16-bit mono)
  wav.writeUInt16LE(2, 32); // block align
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataLen, 40);
  pcm.copy(wav, 44);
  return wav;
}

// ─── Defensive audio-part extraction ─────────────────────────────────────────

const MIME_KEYS = ["mime", "mime_type", "mimeType"] as const;

interface AudioBlock {
  /** Base64-encoded audio payload. */
  data: string;
  /** Audio mime string (may carry `;rate=…`), when the block declares one. */
  mime: string | null;
}

function firstMime(node: Record<string, unknown>): string | null {
  for (const key of MIME_KEYS) {
    const value = node[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** True when this object is an audio part: has base64 `data` AND is typed
 *  audio or carries an audio/ mime. Deep-walking deduplicates the variants the
 *  docs leave open (`{type:"audio", …}` content blocks, `inlineData` parts,
 *  camel vs snake mime keys). */
function asAudioBlock(node: Record<string, unknown>): AudioBlock | null {
  const data = node.data;
  if (typeof data !== "string" || data.length === 0) return null;
  if (node.type === "audio") return { data, mime: firstMime(node) };
  const mime = firstMime(node);
  if (mime && mime.startsWith("audio/")) return { data, mime };
  return null;
}

/**
 * Depth-first search for the first audio block in a parsed JSON response.
 * Walks every object/array (cycle-guarded) so the extractor survives shape
 * drift across the Interactions (`output`/`steps`) and legacy generateContent
 * (`candidates…inlineData`) containers. Document order wins.
 */
function findAudioBlock(root: unknown, seen?: Set<object>): AudioBlock | null {
  if (root === null || typeof root !== "object") return null;
  const visited = seen ?? new Set<object>();
  if (visited.has(root)) return null;
  visited.add(root);
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findAudioBlock(item, visited);
      if (found) return found;
    }
    return null;
  }
  const record = root as Record<string, unknown>;
  const self = asAudioBlock(record);
  if (self) return self;
  for (const value of Object.values(record)) {
    const found = findAudioBlock(value, visited);
    if (found) return found;
  }
  return null;
}

function parseSampleRate(mime: string | null): number | null {
  if (!mime) return null;
  const match = /(?:^|;)\s*rate=(\d+)/i.exec(mime);
  return match ? Number(match[1]) : null;
}

// ─── Config accessors (loose TtsProfileConfig bag, house style) ──────────────

function requireApiKey(config: TtsProfileConfig): string {
  const value = config.apiKey;
  if (typeof value !== "string" || value.trim() === "") {
    throw new GeminiTtsError("Gemini TTS config error: `apiKey` is required");
  }
  return value;
}

function readModel(config: TtsProfileConfig): string {
  const value = config.model;
  return typeof value === "string" && value.trim() !== "" ? value : DEFAULT_MODEL;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export const geminiTtsFactory: TtsBackendFactory = (config) => {
  const apiKey = requireApiKey(config);
  const model = readModel(config);

  const backend: TtsBackend = {
    async generate(req: TtsGenerateRequest): Promise<TtsAudioResult> {
      const voice =
        req.voiceId && req.voiceId.trim() !== "" ? req.voiceId : DEFAULT_VOICE;
      // "Director's notes": natural-language style guidance folds into the input
      // as a preamble (docs prompting guide). Keeping the transcript separated
      // by a blank line also reduces PROHIBITED_CONTENT false rejections.
      const input =
        req.instructions && req.instructions.trim() !== ""
          ? `${req.instructions.trim()}\n\n${req.text}`
          : req.text;

      const response = await fetch(INTERACTIONS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          model,
          input,
          response_format: { type: "audio" },
          generation_config: { speech_config: [{ voice }] },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new GeminiTtsError(
          `Gemini TTS generate failed: ${response.status} ${
            response.statusText
          }${errorText ? `: ${errorText.slice(0, 200)}` : ""}`,
          { status: response.status },
        );
      }

      const payload: unknown = await response.json().catch(() => null);
      const block = findAudioBlock(payload);
      if (!block) {
        throw new GeminiTtsError(
          "Gemini TTS generate returned no audio part in response",
        );
      }

      const pcm = Buffer.from(block.data, "base64");
      const sampleRate = parseSampleRate(block.mime) ?? DEFAULT_SAMPLE_RATE;
      return { audio: pcmToWav(pcm, sampleRate), mime: "audio/wav" };
    },

    async listVoices(): Promise<TtsVoiceInfo[]> {
      return [...GEMINI_TTS_VOICES];
    },

    async listModels(): Promise<import("../tts-backend.js").TtsModelInfo[]> {
      const response = await fetch(MODELS_URL, {
        headers: { "x-goog-api-key": apiKey },
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new GeminiTtsError(
          `Gemini TTS model list failed: ${response.status} ${response.statusText}${errorText ? `: ${errorText.slice(0, 200)}` : ""}`,
          { status: response.status },
        );
      }
      const payload: unknown = await response.json().catch(() => null);
      if (typeof payload !== "object" || payload === null) return [];
      const models = (payload as Record<string, unknown>).models;
      if (!Array.isArray(models)) return [];
      const out: import("../tts-backend.js").TtsModelInfo[] = [];
      for (const entry of models) {
        if (typeof entry !== "object" || entry === null) continue;
        const raw = (entry as Record<string, unknown>).name;
        if (typeof raw !== "string" || raw.length === 0) continue;
        const id = raw.replace(/^models\//, "").trim();
        if (id.length === 0) continue;
        if (!id.includes("tts")) continue;
        out.push({ id, label: id });
      }
      return out;
    },

    async probe(): Promise<TtsProbeResult> {
      // NOTE: the models catalogue returns Google's own shape
      // `{ models: [{ name: "models/<id>", ... }] }` — NOT an OpenAI-style
      // `{ data: [{ id }] }`. The repo's chat-side `listGoogleModels` cannot
      // be reused here because it deliberately FILTERS OUT TTS models
      // (NON_CHAT_MODEL_PATTERNS) — the TTS probe counts exactly those.
      const response = await fetch(MODELS_URL, {
        headers: { "x-goog-api-key": apiKey },
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        return {
          ok: false,
          detail: `${response.status} ${response.statusText}${
            errorText ? `: ${errorText.slice(0, 200)}` : ""
          }`,
        };
      }
      const payload: unknown = await response.json().catch(() => null);
      const ttsCount = countTtsModels(payload);
      return { ok: true, detail: `${ttsCount} TTS models` };
    },

    async dispose(): Promise<void> {
      // Stateless — nothing to release.
    },

    capabilities(): TtsBackendCapabilities {
      return { supportsCloning: false };
    },
  };

  return backend;
};

/** Count catalogue entries whose model name contains "-tts" (the TTS family).
 *  Reads the real /v1beta/models shape: `{ models: [{ name }] }`. */
function countTtsModels(payload: unknown): number {
  if (typeof payload !== "object" || payload === null) return 0;
  const models = (payload as Record<string, unknown>).models;
  if (!Array.isArray(models)) return 0;
  let count = 0;
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = (entry as Record<string, unknown>).name;
    if (typeof name === "string" && name.includes("-tts")) count += 1;
  }
  return count;
}

// Module-scope registration (protocol-registry pattern): importing this module
// makes the gemini slug constructible via createTtsBackend.
registerTtsBackend(TTS_BACKEND.Gemini, geminiTtsFactory);