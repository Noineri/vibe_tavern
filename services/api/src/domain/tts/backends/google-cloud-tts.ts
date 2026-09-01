/**
 * Google Cloud Text-to-Speech backend (TPE-14, closes Wave C).
 *
 * API facts below were verified 2026-09-03 against the live Google docs
 * (TTS REST v1 reference: text.synthesize / AudioConfig /
 * VoiceSelectionParams / voices.list; Google Identity: OAuth 2.0
 * server-to-server service-account flow; TTS authentication page):
 * - Auth: v1 REST requires OAuth scope
 *   https://www.googleapis.com/auth/cloud-platform — NO API-key support.
 *   The self-hoster credential is the service-account KEY FILE (JSON with
 *   client_email + private_key PEM + private_key_id + token_uri), driven
 *   through the documented JWT-bearer exchange: RS256 JWT (header
 *   {alg,typ,kid?}, claims {iss,scope,aud,iat,exp} with exp ≤ iat+1h,
 *   base64url WITHOUT padding) → POST {token_uri} form-encoded
 *   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=… →
 *   {access_token, expires_in: 3600}, reused until expiry.
 * - Credential storage (owner decision 2026-09-02): the apiKey column
 *   holds the FULL service-account JSON text — secrets stay in the typed
 *   SQL column, the config bag carries nothing secret, the value is never
 *   rendered back (F2b stored-key semantics).
 * - Synthesis: POST https://texttospeech.googleapis.com/v1/text:synthesize
 *   with Authorization: Bearer. Body: input/voice/audioConfig are all
 *   REQUIRED; voice.languageCode (marked Required in
 *   VoiceSelectionParams) is derived from the voice-name prefix (first
 *   two `-` segments). audioConfig.audioEncoding fixed "MP3"; tuning =
 *   speakingRate [0.25, 2.0] (1.0 native), pitch [−20, 20] semitones,
 *   volumeGainDb [−96, 16] dB (0 = native) — neutral values OMITTED.
 *   Unlike Polly/Azure no SSML envelope is ever needed: tuning rides
 *   AudioConfig, the input stays plain text.
 * - Response: {audioContent: <base64>} — NOT a raw audio stream; decoded
 *   to bytes, mime audio/mpeg (the MP3 encoding we requested).
 * - Voices catalog (LIVE): GET /v1/voices → {voices:[{languageCodes[],
 *   name, ssmlGender, naturalSampleRateHertz}]} — v1 documents NO
 *   pagination (single response). Map: id=name, label `name · gender`
 *   (gender dropped when UNSPECIFIED), lang=languageCodes[0] lowercase.
 *   The engine family (Neural2/Studio/Chirp/Wavenet/Standard) is part of
 *   the voice NAME — there is no model/engine field anywhere (the voice
 *   picker is the single selector).
 * - Empty voiceId is not legal (voice is a REQUIRED request field).
 * - No usable cloning surface (Custom Voice = AutoML enterprise program,
 *   gated) → capabilities().supportsCloning stays false.
 */

import { createSign } from "node:crypto";

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

const SYNTHESIS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
const VOICES_URL = "https://texttospeech.googleapis.com/v1/voices";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** The scope the TTS REST reference requires on every method. */
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** The docs' JWT-bearer grant type (URL-encoded on the wire). */
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** exp ≤ iat + 1 hour per the claim-set table. */
const JWT_LIFETIME_SECONDS = 3600;

/** audioEncoding fixed to the house mp3 family; the base64 audioContent
 *  decodes to an MP3 stream. */
const OUTPUT_ENCODING = "MP3";
const OUTPUT_MIME = "audio/mpeg";

const ERROR_BODY_EXCERPT_LENGTH = 200;

/** speakingRate — documented [0.25, 2.0] multiplier (NOT the OpenAI
 *  0.25–4 range; re-verified 2026-09-03). */
const MIN_SPEAKING_RATE = 0.25;
const MAX_SPEAKING_RATE = 2;
const NEUTRAL_SPEAKING_RATE = 1;
/** pitch — documented [−20, 20] semitones. */
const MIN_PITCH_ST = -20;
const MAX_PITCH_ST = 20;
/** volumeGainDb — documented [−96, 16] dB (0 = native amplitude). */
const MIN_VOLUME_DB = -96;
const MAX_VOLUME_DB = 16;

/** Refresh the token this many ms before its documented expiry — a
 *  synthesis call straddling the boundary must not 401. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

export class GoogleCloudTtsError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport/parse-level failures). */
  readonly status?: number;
  constructor(message: string, options?: { status?: number }) {
    super(message);
    this.name = "GoogleCloudTtsError";
    this.status = options?.status;
  }
}

// ─── Service-account credential parsing ─────────────────────────────────────

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri: string;
}

/** Parse the pasted service-account JSON. Throws a named error (naming
 *  the missing field) so the pre-fetch guards stay zero-fetch. */
export function parseServiceAccount(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GoogleCloudTtsError(
      "Google Cloud TTS apiKey must be the service-account JSON file contents (the pasted value is not valid JSON).",
    );
  }
  const entry = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const clientEmail = entry["client_email"];
  const privateKey = entry["private_key"];
  const tokenUri = entry["token_uri"];
  if (typeof clientEmail !== "string" || clientEmail.length === 0) {
    throw new GoogleCloudTtsError('Service-account JSON is missing the "client_email" field.');
  }
  if (typeof privateKey !== "string" || privateKey.length === 0) {
    throw new GoogleCloudTtsError('Service-account JSON is missing the "private_key" field.');
  }
  const privateKeyId = entry["private_key_id"];
  return {
    client_email: clientEmail,
    private_key: privateKey,
    private_key_id: typeof privateKeyId === "string" ? privateKeyId : undefined,
    token_uri: typeof tokenUri === "string" && tokenUri.length > 0 ? tokenUri : DEFAULT_TOKEN_URL,
  };
}

// ─── JWT (RS256) — the documented self-signed assertion ─────────────────────

/** base64url WITHOUT padding (the docs' invalid_grant row: "without
 *  newlines or padding equal signs"). */
function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export interface ServiceAccountJwtInput {
  serviceAccount: ServiceAccountKey;
  scope?: string;
  /** Unix seconds — injectable for the structure tests. */
  nowSeconds?: number;
}

/** Build + sign the JWT per the documented claim set. The signature
 *  algorithm is RSASSA-PKCS1-v1_5 with SHA-256 (node:crypto
 *  "RSA-SHA256"); tests verify it against the RSA public key. */
export function signServiceAccountJwt(input: ServiceAccountJwtInput): string {
  const account = input.serviceAccount;
  const iat = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + JWT_LIFETIME_SECONDS;
  const header: Record<string, string> = { alg: "RS256", typ: "JWT" };
  if (account.private_key_id !== undefined) header["kid"] = account.private_key_id;
  const claims = {
    iss: account.client_email,
    scope: input.scope ?? SCOPE,
    aud: account.token_uri,
    iat,
    exp,
  };
  const encodedHeader = base64Url(Buffer.from(JSON.stringify(header), "utf8"));
  const encodedClaims = base64Url(Buffer.from(JSON.stringify(claims), "utf8"));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(account.private_key);
  return `${signingInput}.${base64Url(signature)}`;
}

// ─── Access-token exchange + module-level cache ──────────────────────────────
//
// Backend instances are created per request (adapter factory), so a
// per-instance cache would re-run the RSA exchange on EVERY synthesis.
// The cache is keyed by the credential identity (client_email + token
// endpoint) and refreshed with a safety margin. Tests reset it through
// the seam below (house lesson: seams over module mocks).

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

const tokenCache = new Map<string, CachedToken>();

/** Test seam — clears the module-level token cache (TPE-9a lesson). */
export function __resetGoogleTokenCacheForTests(): void {
  tokenCache.clear();
}

interface TokenExchange {
  accessToken: string;
  expiresInSeconds: number;
}

async function exchangeToken(serviceAccount: ServiceAccountKey): Promise<TokenExchange> {
  const assertion = signServiceAccountJwt({ serviceAccount });
  const response = await fetch(serviceAccount.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }).toString(),
  });
  if (!response.ok) {
    const excerpt = await readErrorExcerpt(response);
    throw new GoogleCloudTtsError(
      `Google OAuth token exchange failed with HTTP ${response.status}: ${excerpt || "(empty body)"}`,
      { status: response.status },
    );
  }
  const parsed: unknown = await response.json();
  const entry = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const accessToken = entry["access_token"];
  const expiresIn = entry["expires_in"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new GoogleCloudTtsError("Google OAuth token response is missing access_token.");
  }
  return {
    accessToken,
    expiresInSeconds: typeof expiresIn === "number" && Number.isFinite(expiresIn) ? expiresIn : JWT_LIFETIME_SECONDS,
  };
}

async function accessTokenFor(serviceAccount: ServiceAccountKey): Promise<string> {
  const cacheKey = `${serviceAccount.client_email}|${serviceAccount.token_uri}`;
  const cached = tokenCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAtMs > Date.now()) return cached.accessToken;
  const exchange = await exchangeToken(serviceAccount);
  const expiresAtMs = Date.now() + Math.max(0, exchange.expiresInSeconds * 1000 - TOKEN_EXPIRY_MARGIN_MS);
  tokenCache.set(cacheKey, { accessToken: exchange.accessToken, expiresAtMs });
  return exchange.accessToken;
}

// ─── Config accessors (TtsProfileConfig is Record<string, unknown>) ─────────

interface GoogleCloudTtsConfig {
  /** The pasted service-account JSON — the typed apiKey column at the DB
   *  edge; parsed lazily so probe() can fail soft. */
  serviceAccountJson: string;
  speakingRate?: number;
  pitchSt?: number;
  volumeGainDb?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseNumberField(config: TtsProfileConfig, key: string, min: number, max: number): number | undefined {
  const raw = config[key];
  return typeof raw === "number" && Number.isFinite(raw) ? clamp(raw, min, max) : undefined;
}

function parseConfig(config: TtsProfileConfig): GoogleCloudTtsConfig {
  const apiKey = config["apiKey"];
  return {
    serviceAccountJson: typeof apiKey === "string" ? apiKey : "",
    // Neutral values (1.0×, 0 st, 0 dB) mean "no change" — normalized
    // away here so audioConfig only ever carries real adjustments.
    speakingRate: parseNumberField(config, "speakingRate", MIN_SPEAKING_RATE, MAX_SPEAKING_RATE),
    pitchSt: parseNumberField(config, "pitchSt", MIN_PITCH_ST, MAX_PITCH_ST),
    volumeGainDb: parseNumberField(config, "volumeGainDb", MIN_VOLUME_DB, MAX_VOLUME_DB),
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
  throw new GoogleCloudTtsError(
    `Google Cloud TTS ${operation} failed with HTTP ${response.status}: ${excerpt || "(empty body)"}`,
    { status: response.status },
  );
}

// ─── Request shaping ─────────────────────────────────────────────────────────

/** voice.languageCode is marked Required in VoiceSelectionParams; the
 *  authoritative code per voice arrives in voices.list languageCodes[],
 *  but at synthesis time only the id is known — derive from the name
 *  prefix (first two `-` segments; engine families with hyphenated ids
 *  like en-US-Chirp3-HD-Achird still yield en-US). */
export function languageCodeFromVoiceName(voiceName: string): string {
  return voiceName.split("-").slice(0, 2).join("-");
}

export interface SynthesizeBodyInput {
  text: string;
  voiceName: string;
  speakingRate?: number;
  pitchSt?: number;
  volumeGainDb?: number;
}

/** The documented request shape — exported for the body pins. */
export function buildSynthesizeBody(input: SynthesizeBodyInput): Record<string, unknown> {
  const audioConfig: Record<string, unknown> = { audioEncoding: OUTPUT_ENCODING };
  if (input.speakingRate !== undefined && input.speakingRate !== NEUTRAL_SPEAKING_RATE) {
    audioConfig["speakingRate"] = input.speakingRate;
  }
  if (input.pitchSt !== undefined && input.pitchSt !== 0) {
    audioConfig["pitch"] = input.pitchSt;
  }
  if (input.volumeGainDb !== undefined && input.volumeGainDb !== 0) {
    audioConfig["volumeGainDb"] = input.volumeGainDb;
  }
  return {
    input: { text: input.text },
    voice: {
      languageCode: languageCodeFromVoiceName(input.voiceName),
      name: input.voiceName,
    },
    audioConfig,
  };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class GoogleCloudTtsBackend implements TtsBackend {
  private readonly cfg: GoogleCloudTtsConfig;

  constructor(config: TtsProfileConfig) {
    this.cfg = parseConfig(config);
  }

  private requireServiceAccount(): ServiceAccountKey {
    if (!this.cfg.serviceAccountJson.trim()) {
      throw new GoogleCloudTtsError(
        "Google Cloud TTS requires the service-account JSON pasted into the apiKey field.",
      );
    }
    return parseServiceAccount(this.cfg.serviceAccountJson);
  }

  async generate(req: TtsGenerateRequest): Promise<TtsAudioResult> {
    const serviceAccount = this.requireServiceAccount();
    const voice = req.voiceId.trim();
    // voice is a REQUIRED request field — fail fast instead of letting
    // the JSON body 400 deep in server-side validation.
    if (!voice) {
      throw new GoogleCloudTtsError("Google Cloud synthesis requires a non-empty voiceId (e.g. en-US-Neural2-F).");
    }

    const accessToken = await accessTokenFor(serviceAccount);
    const body = buildSynthesizeBody({
      text: req.text,
      voiceName: voice,
      speakingRate: this.cfg.speakingRate,
      pitchSt: this.cfg.pitchSt,
      volumeGainDb: this.cfg.volumeGainDb,
    });
    const response = await fetch(SYNTHESIS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    await expectOk(response, "text-to-speech");
    const parsed: unknown = await response.json();
    const entry = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const audioContent = entry["audioContent"];
    if (typeof audioContent !== "string" || audioContent.length === 0) {
      throw new GoogleCloudTtsError("Google Cloud TTS response is missing audioContent (base64 audio).");
    }
    return { audio: Buffer.from(audioContent, "base64"), mime: OUTPUT_MIME };
  }

  async listVoices(): Promise<TtsVoiceInfo[]> {
    const serviceAccount = this.requireServiceAccount();
    const accessToken = await accessTokenFor(serviceAccount);
    const response = await fetch(VOICES_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    await expectOk(response, "voice list");
    const parsed: unknown = await response.json();
    return parseVoicesResponse(parsed);
  }

  async probe(): Promise<TtsProbeResult> {
    if (!this.cfg.serviceAccountJson.trim()) {
      return { ok: false, detail: "apiKey (the service-account JSON) is required for Google Cloud TTS." };
    }
    try {
      const serviceAccount = this.requireServiceAccount();
      // A REAL credential check: a bad/revoked key or a key without the
      // TTS scope fails at the token exchange itself.
      await accessTokenFor(serviceAccount);
      return { ok: true, detail: "OAuth token exchange succeeded" };
    } catch (error) {
      if (error instanceof GoogleCloudTtsError) {
        return { ok: false, detail: error.status !== undefined ? `${error.status} ${error.message}` : error.message };
      }
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  // Nothing to tear down — the token cache is module-level by design.
  async dispose(): Promise<void> {}

  capabilities(): TtsBackendCapabilities {
    // Custom Voice is an AutoML enterprise program (gated) — no cloning
    // surface for a self-hoster; keeps the editor's clone section hidden.
    return { supportsCloning: false };
  }
}

// ─── Response parsing (unknown at the fetch edge) ────────────────────────────

interface ParsedGoogleVoice {
  name: string;
  ssmlGender?: unknown;
  languageCodes?: unknown;
}

function isParsedVoice(value: unknown): value is ParsedGoogleVoice {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry["name"] === "string" && entry["name"].length > 0;
}

/** The v1 roster arrives as ONE response (no pagination documented) —
 *  zero hardcoded voices (owner rule 2026-09-01). */
export function parseVoicesResponse(parsed: unknown): TtsVoiceInfo[] {
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Record<string, unknown>)["voices"])) {
    throw new GoogleCloudTtsError("Google Cloud voices.list returned a payload without a voices array.");
  }
  const voices = ((parsed as Record<string, unknown>)["voices"] as unknown[])
    .filter(isParsedVoice)
    .map((entry) => {
      const gender =
        typeof entry.ssmlGender === "string" && entry.ssmlGender !== "SSML_VOICE_GENDER_UNSPECIFIED"
          ? entry.ssmlGender
          : undefined;
      const languageCode = Array.isArray(entry.languageCodes)
        ? entry.languageCodes.find((code): code is string => typeof code === "string")
        : undefined;
      const label = gender !== undefined ? `${entry.name} · ${gender}` : entry.name;
      return { id: entry.name, label, lang: (languageCode ?? "").toLowerCase() } satisfies TtsVoiceInfo;
    });
  return voices.sort((a, b) => a.label.localeCompare(b.label));
}

// ─── Registry wiring ─────────────────────────────────────────────────────────

export const googleCloudTtsFactory: TtsBackendFactory = (config: TtsProfileConfig) =>
  new GoogleCloudTtsBackend(config);

// Module-scope registration (protocol-registry pattern): importing this
// adapter makes the 'google-cloud' slug creatable via the registry.
registerTtsBackend(TTS_BACKEND.GoogleCloud, googleCloudTtsFactory);
