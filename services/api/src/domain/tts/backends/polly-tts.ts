/**
 * Amazon Polly TTS backend (TPE-13).
 *
 * API facts below were verified 2026-09-02 against the live AWS docs
 * (API Reference SynthesizeSpeech/DescribeVoices, General Reference
 * service endpoints pol.html, General Reference SigV4 signing pages,
 * Polly Developer Guide supportedtags/prosody-tag):
 * - Synthesis: POST https://polly.{region}.amazonaws.com/v1/speech with a
 *   JSON body. Required: OutputFormat (fixed `mp3` → the 200 response's
 *   Content-Type is audio/mpeg per the docs' format table), Text, VoiceId.
 *   Optional: Engine, LanguageCode, SampleRate, TextType (default `text`),
 *   LexiconNames, SpeechMarkTypes. Text limit: 6000 chars total.
 * - Engine (standard|neural|long-form|generative) defaults to standard;
 *   a voice that does not support the chosen engine → EngineNotSupported
 *   400. Which engines a voice supports arrives in the live roster
 *   (SupportedEngines), so the UI select offers exactly the 4 documented
 *   values and the label marks non-standard voices.
 * - Voices catalog (LIVE): GET /v1/voices with an OPAQUE NextToken
 *   pagination (docs: ≤4096 chars, loop until absent) →
 *   {Voices:[{Gender, Id, LanguageCode, LanguageName, Name,
 *   SupportedEngines}], NextToken?}. Permission polly:DescribeVoices.
 * - Auth: SigV4 header signing (Authorization header), service `polly`,
 *   region from config. The signer below is our own implementation with
 *   aws4fetch (MIT, mhart) as the reference implementation — owner
 *   decision 2026-09-02, plan commit 63144e4; the canonicalization
 *   pipeline mirrors that library, the crypto is native node:crypto.
 *   Correctness is pinned by the OFFICIAL derivation vector published in
 *   the AWS docs (signature-v4-examples.html — see the signer tests).
 * - SSML tuning (prosody): standard voices support the full prosody tag;
 *   neural/long-form/generative support `rate` and `volume` ONLY (pitch is
 *   NOT supported there → we do not expose pitch at all). `rate` is an
 *   ABSOLUTE percentage with the documented range 20–200 (100 = no
 *   change); `volume` is relative ±ndB. When any tuning is set the text
 *   is sent as TextType "ssml" inside a minimal speak/prosody envelope,
 *   otherwise the plain text body is used (TextType default).
 * - Credentials: AccessKeyId (a console identifier, NOT a secret → config
 *   field above the masked key) + SecretAccessKey (the typed apiKey
 *   column) + region (REQUIRED config field, TPE-12 pattern). STS session
 *   tokens are a documented v1 skip.
 * - No voice cloning surface exists in the Polly REST API →
 *   capabilities().supportsCloning stays false (hides the clone section).
 * - Empty voiceId is not legal (VoiceId is a required field and Polly
 *   documents no default voice).
 */

import { createHash, createHmac } from "node:crypto";

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

const SYNTHESIS_PATH = "/v1/speech";
const VOICES_PATH = "/v1/voices";
/** SigV4 service code (credential scope element). */
const SERVICE = "polly";

/** Fixed house output format (mp3 family) — see file header. */
const OUTPUT_FORMAT = "mp3";
const OUTPUT_MIME = "audio/mpeg";

/** Error body excerpt length included in HTTP-failure messages. */
const ERROR_BODY_EXCERPT_LENGTH = 200;

/** Documented engine values (SynthesizeSpeech Engine enum). */
const ENGINES = ["standard", "neural", "long-form", "generative"] as const;
type PollyEngine = (typeof ENGINES)[number];

/** prosody `rate` — ABSOLUTE percentage, documented range 20–200
 *  (100 = no change → the attribute is omitted at the fallback). */
const MIN_RATE_PERCENT = 20;
const MAX_RATE_PERCENT = 200;
const NEUTRAL_RATE_PERCENT = 100;
/** prosody `volume` — relative ±ndB (0 dB = no change → omitted). */
const MIN_VOLUME_DB = -12;
const MAX_VOLUME_DB = 12;

/** Hostile-loop guard: the real roster pages 2–3 times; 50 pages can only
 *  happen if a misbehaving endpoint feeds us an endless token chain. */
const MAX_VOICES_PAGES = 50;

export class PollyTtsError extends Error {
  /** Upstream HTTP status when the failure came from a non-2xx response
   *  (undefined for transport-level failures). */
  readonly status?: number;
  constructor(message: string, options?: { status?: number }) {
    super(message);
    this.name = "PollyTtsError";
    this.status = options?.status;
  }
}

// ─── SigV4 signer (reference: aws4fetch canonicalization, native crypto) ────
//
// Exported for the vector tests: the derivation function is driven with
// the official docs vector (service iam), so the service/region/date are
// parameters, not constants.

/** AWS SigV4 headers that are never part of the signed set (the aws-sdk-js
 *  list aws4fetch carries — user-agent/content-length are hop-by-hop or
 *  client-specific, authorization is the product itself). Our requests
 *  only set content-type + x-amz-date, so this is a guard, not a filter
 *  that fires. */
const UNSIGNABLE_HEADERS = new Set([
  "authorization",
  "content-length",
  "user-agent",
  "presigned-expires",
  "expect",
  "x-amzn-trace-id",
  "range",
  "connection",
]);

/** The encodeURIComponent gap the docs warn about: RFC 3986 unreserved
 *  omits `!'()*`, which encodeURIComponent passes through — AWS requires
 *  every byte outside A-Za-z0-9-._~ encoded, uppercase hex. */
function encodeRfc3986(urlEncoded: string): string {
  return urlEncoded.replace(/['()*!]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Canonical URI path (non-S3 form): collapse duplicate slashes, encode
 *  every byte except the slashes themselves. Polly's paths are fixed
 *  ASCII, so this is normalization insurance rather than a live path. */
function canonicalPath(pathname: string): string {
  const collapsed = pathname.replace(/\/+/g, "/");
  const encoded = encodeURIComponent(collapsed).replace(/%2F/g, "/");
  return encodeRfc3986(encoded);
}

/** Canonical query string: encode key and value independently, sort by the
 *  ENCODED pair, join. Sorting after encoding matters for the base64
 *  NextToken (its `=+/` encode to %3D/%2B/%2F and reorder). */
function canonicalQuery(url: URL): string {
  return [...url.searchParams]
    .filter(([key]) => key.length > 0)
    .map((pair) => pair.map((part) => encodeRfc3986(encodeURIComponent(part))) as [string, string])
    .sort(([k1, v1], [k2, v2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : v1 < v2 ? -1 : v1 > v2 ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** The documented key-derivation chain:
 *  HMAC("AWS4"+secret, date) → (region) → (service) → ("aws4_request").
 *  Test-pinned byte-for-byte against the official docs vector. */
export function deriveSigV4SigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac("AWS4" + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export interface SigV4SignParams {
  method: string;
  /** Full URL including any query string. */
  url: string;
  /** Request headers to set (content-type for the JSON POST); host and
   *  x-amz-date are derived, everything in UNSIGNABLE_HEADERS is kept but
   *  not signed. */
  headers?: Record<string, string>;
  body?: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** ISO-8601 basic datetime `YYYYMMDDTHHMMSSZ` — injectable for tests. */
  datetime?: string;
}

export interface SigV4SignedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Sign a request per the documented header-auth form. The Authorization
 *  header has NO comma after the algorithm (docs spell this out) and
 *  SignedHeaders lists exactly the canonicalized header names. */
export function signSigV4Request(params: SigV4SignParams): SigV4SignedRequest {
  const url = new URL(params.url);
  const datetime = params.datetime ?? new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(params.headers ?? {})) {
    if (name.toLowerCase() !== "host") headers[name.toLowerCase()] = value;
  }
  headers["x-amz-date"] = datetime;

  const signableHeaders = ["host", ...Object.keys(headers)]
    .filter((header) => !UNSIGNABLE_HEADERS.has(header))
    .sort();
  const signedHeaders = signableHeaders.join(";");
  const canonicalHeaders = signableHeaders
    .map((header) => `${header}:${(header === "host" ? url.host : headers[header] ?? "").replace(/\s+/g, " ").trim()}`)
    .join("\n");

  const canonicalRequest = [
    params.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url),
    canonicalHeaders + "\n",
    signedHeaders,
    sha256Hex(params.body ?? ""),
  ].join("\n");

  const dateStamp = datetime.slice(0, 8);
  const scope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", datetime, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = deriveSigV4SigningKey(params.secretAccessKey, dateStamp, params.region, params.service);
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { method: params.method.toUpperCase(), url, headers, body: params.body };
}

// ─── Config accessors (TtsProfileConfig is Record<string, unknown>) ─────────

interface PollyTtsConfig {
  /** SecretAccessKey — the typed apiKey column at the DB edge. */
  secretAccessKey: string;
  /** AccessKeyId — non-secret console identifier (config bag). */
  accessKeyId: string;
  region: string;
  engine?: PollyEngine;
  ratePercent?: number;
  volumeDb?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseEngine(raw: unknown): PollyEngine | undefined {
  return typeof raw === "string" && (ENGINES as readonly string[]).includes(raw) ? (raw as PollyEngine) : undefined;
}

function parseNumberField(config: TtsProfileConfig, key: string, min: number, max: number): number | undefined {
  const raw = config[key];
  return typeof raw === "number" && Number.isFinite(raw) ? clamp(raw, min, max) : undefined;
}

function parseConfig(config: TtsProfileConfig): PollyTtsConfig {
  const secretAccessKey = config["apiKey"];
  const accessKeyId = config["accessKeyId"];
  const region = config["region"];
  return {
    secretAccessKey: typeof secretAccessKey === "string" ? secretAccessKey : "",
    accessKeyId: typeof accessKeyId === "string" ? accessKeyId.trim() : "",
    region: typeof region === "string" ? region.trim() : "",
    engine: parseEngine(config["engine"]),
    // The neutral values (100 %, 0 dB) mean "no change" — normalized away
    // here so the envelope builder only ever sees real adjustments.
    ratePercent: parseNumberField(config, "ratePercent", MIN_RATE_PERCENT, MAX_RATE_PERCENT),
    volumeDb: parseNumberField(config, "volumeDb", MIN_VOLUME_DB, MAX_VOLUME_DB),
  };
}

// ─── SSML construction (tuning envelope) ─────────────────────────────────────

/** SSML-escape the characters that can appear in element text; attribute
 *  values below are all generated, never user text. */
function escapeSsmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Minimal `<speak><prosody>` envelope — emitted ONLY when a tuning is
 *  set (the docs' own examples use the bare `<speak>` form; there is no
 *  xml:lang because the Polly voice id carries no locale). */
export function buildSsml(text: string, tuning: { ratePercent?: number; volumeDb?: number }): string {
  const attrs: string[] = [];
  if (tuning.ratePercent !== undefined && tuning.ratePercent !== NEUTRAL_RATE_PERCENT) {
    attrs.push(`rate='${tuning.ratePercent}%'`);
  }
  if (tuning.volumeDb !== undefined && tuning.volumeDb !== 0) {
    attrs.push(`volume='${tuning.volumeDb >= 0 ? "+" : ""}${tuning.volumeDb}dB'`);
  }
  const escaped = escapeSsmlText(text);
  const inner = attrs.length > 0 ? `<prosody ${attrs.join(" ")}>${escaped}</prosody>` : escaped;
  return `<speak>${inner}</speak>`;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function endpointUrl(region: string, path: string, query?: Record<string, string>): string {
  const url = new URL(`https://polly.${region}.amazonaws.com${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

function signedFetchInit(
  credentials: { secretAccessKey: string; accessKeyId: string; region: string },
  init: { method: "GET" | "POST"; url: string; body?: string },
): { url: string; init: RequestInit } {
  const signed = signSigV4Request({
    method: init.method,
    url: init.url,
    headers: init.method === "POST" ? { "content-type": "application/json" } : {},
    body: init.body,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    region: credentials.region,
    service: SERVICE,
  });
  return {
    url: signed.url.toString(),
    init: { method: signed.method, headers: signed.headers, body: signed.body },
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
  throw new PollyTtsError(
    `Polly ${operation} failed with HTTP ${response.status}: ${excerpt || "(empty body)"}`,
    { status: response.status },
  );
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class PollyTtsBackend implements TtsBackend {
  private readonly cfg: PollyTtsConfig;

  constructor(config: TtsProfileConfig) {
    this.cfg = parseConfig(config);
  }

  private requireCredentials(): { secretAccessKey: string; accessKeyId: string; region: string } {
    if (!this.cfg.secretAccessKey) {
      throw new PollyTtsError("Polly backend requires a non-empty apiKey (the Secret Access Key) in the profile config.");
    }
    if (!this.cfg.accessKeyId) {
      throw new PollyTtsError("Polly backend requires a non-empty accessKeyId in the profile config.");
    }
    // Region has no default — fail BEFORE any request (TPE-12 pattern).
    if (!this.cfg.region) {
      throw new PollyTtsError("Polly backend requires a non-empty region (e.g. us-east-1) in the profile config.");
    }
    return { secretAccessKey: this.cfg.secretAccessKey, accessKeyId: this.cfg.accessKeyId, region: this.cfg.region };
  }

  async generate(req: TtsGenerateRequest): Promise<TtsAudioResult> {
    const credentials = this.requireCredentials();
    const voice = req.voiceId.trim();
    // VoiceId is a required API field and Polly documents no default —
    // fail fast instead of letting the JSON body 400 deep in validation.
    if (!voice) {
      throw new PollyTtsError("Polly synthesis requires a non-empty voiceId (e.g. Joanna).");
    }

    const tuningSet =
      this.cfg.ratePercent !== undefined && this.cfg.ratePercent !== NEUTRAL_RATE_PERCENT
      || this.cfg.volumeDb !== undefined && this.cfg.volumeDb !== 0;
    const body: Record<string, unknown> = {
      OutputFormat: OUTPUT_FORMAT,
      Text: tuningSet ? buildSsml(req.text, { ratePercent: this.cfg.ratePercent, volumeDb: this.cfg.volumeDb }) : req.text,
      VoiceId: voice,
    };
    if (this.cfg.engine !== undefined) body["Engine"] = this.cfg.engine;
    if (tuningSet) body["TextType"] = "ssml";

    const { url, init } = signedFetchInit(credentials, {
      method: "POST",
      url: endpointUrl(this.cfg.region, SYNTHESIS_PATH),
      body: JSON.stringify(body),
    });
    const response = await fetch(url, init);
    await expectOk(response, "text-to-speech");
    // OutputFormat is fixed to mp3 → the docs' table maps it to
    // audio/mpeg; trust the header when present, fall back to the table.
    const contentType = response.headers.get("content-type");
    const mime = contentType !== null && contentType.length > 0 ? contentType : OUTPUT_MIME;
    return { audio: Buffer.from(await response.arrayBuffer()), mime };
  }

  async listVoices(): Promise<TtsVoiceInfo[]> {
    const credentials = this.requireCredentials();

    const collected: TtsVoiceInfo[] = [];
    let nextToken: string | undefined;
    const seenTokens = new Set<string>();
    for (let page = 0; page < MAX_VOICES_PAGES; page++) {
      const query = nextToken === undefined ? undefined : { NextToken: nextToken };
      const { url, init } = signedFetchInit(credentials, {
        method: "GET",
        url: endpointUrl(credentials.region, VOICES_PATH, query),
      });
      const response = await fetch(url, init);
      await expectOk(response, "voice list");
      const parsed: unknown = await response.json();
      collected.push(...parseVoicesPage(parsed));

      const token = readNextToken(parsed);
      if (token === undefined || token.length === 0) return sortVoices(collected);
      // Opaque tokens: guard against a hostile/misbehaving endpoint that
      // feeds the same token forever (the real API pages 2–3 times).
      if (seenTokens.has(token)) return sortVoices(collected);
      seenTokens.add(token);
      nextToken = token;
    }
    return sortVoices(collected);
  }

  async probe(): Promise<TtsProbeResult> {
    if (!this.cfg.secretAccessKey) return { ok: false, detail: "apiKey (Secret Access Key) is required for Polly." };
    if (!this.cfg.accessKeyId) return { ok: false, detail: "accessKeyId is required for Polly." };
    if (!this.cfg.region) return { ok: false, detail: "region is required for Polly (e.g. us-east-1)." };
    try {
      const { url, init } = signedFetchInit(this.requireCredentials(), {
        method: "GET",
        url: endpointUrl(this.cfg.region, VOICES_PATH),
      });
      const response = await fetch(url, init);
      if (!response.ok) {
        const excerpt = await readErrorExcerpt(response);
        return { ok: false, detail: `${response.status} ${excerpt || "(empty body)"}`.trim() };
      }
      return { ok: true, detail: "voice list reachable" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  // Nothing to tear down — Polly has no local state.
  async dispose(): Promise<void> {}

  capabilities(): TtsBackendCapabilities {
    // The Polly REST API exposes no cloning surface — supportsCloning
    // false keeps the editor's clone section hidden.
    return { supportsCloning: false };
  }
}

// ─── Response parsing (unknown at the fetch edge) ────────────────────────────

interface ParsedPollyVoice {
  Id: string;
  Gender?: unknown;
  LanguageCode?: unknown;
  LanguageName?: unknown;
  Name?: unknown;
  SupportedEngines?: unknown;
}

function isParsedVoice(value: unknown): value is ParsedPollyVoice {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry["Id"] === "string" && entry["Id"].length > 0;
}

function readString(entry: ParsedPollyVoice, key: keyof ParsedPollyVoice): string | undefined {
  const raw = entry[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function toVoiceInfo(entry: ParsedPollyVoice): TtsVoiceInfo {
  const name = readString(entry, "Name") ?? entry.Id;
  const gender = readString(entry, "Gender");
  const languageName = readString(entry, "LanguageName");
  const languageCode = readString(entry, "LanguageCode");
  // Standard is the API's implicit default engine; voices that CANNOT run
  // standard get an explicit engines marker, because with them an unset
  // engine would 400 (EngineNotSupported) — the neural-only trap.
  const engines = Array.isArray(entry.SupportedEngines)
    ? entry.SupportedEngines.filter((e): e is string => typeof e === "string")
    : [];
  const enginesMarker = engines.length > 0 && !engines.includes("standard") ? ` · ${engines.join(",")}` : "";
  const parts = [name, gender, languageName].filter((part): part is string => part !== undefined);
  return {
    id: entry.Id,
    label: `${parts.join(" · ")}${enginesMarker}`,
    lang: (languageCode ?? "").toLowerCase(),
  };
}

function readNextToken(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const token = (parsed as Record<string, unknown>)["NextToken"];
  return typeof token === "string" ? token : undefined;
}

/** One page of the live roster — the full catalog is the pagination loop
 *  in listVoices(); zero hardcoded voices (owner rule 2026-09-01). */
export function parseVoicesPage(parsed: unknown): TtsVoiceInfo[] {
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Record<string, unknown>)["Voices"])) {
    throw new PollyTtsError("Polly DescribeVoices returned a payload without a Voices array.");
  }
  return ((parsed as Record<string, unknown>)["Voices"] as unknown[]).filter(isParsedVoice).map(toVoiceInfo);
}

function sortVoices(voices: TtsVoiceInfo[]): TtsVoiceInfo[] {
  return [...voices].sort((a, b) => a.label.localeCompare(b.label));
}

// ─── Registry wiring ─────────────────────────────────────────────────────────

export const pollyTtsFactory: TtsBackendFactory = (config: TtsProfileConfig) => new PollyTtsBackend(config);

// Module-scope registration (protocol-registry pattern): importing this
// adapter makes the 'polly' slug creatable via the registry.
registerTtsBackend(TTS_BACKEND.Polly, pollyTtsFactory);
