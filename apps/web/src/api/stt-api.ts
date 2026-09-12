/**
 * STT profile + transcription API client (STT_PLAN ST-5b). Mirrors
 * tts-api.ts: CRUD via the typed Hono RPC client; transcription via raw
 * fetch with mobile-token query (multipart audio — no RPC shape fits it).
 */

import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";
import { getGatewayBaseUrl } from "../gateway-client.js";
import { appendTokenQuery } from "../lib/mobile-token.js";

// ─── Wire record shape (mirrors the backend domain SttProfile / the
//     api-contracts ClientSttProfileRecord) ────────────────────────────────

export interface SttProfileRecord {
  id: string;
  name: string;
  backend: string;
  /** Backend-specific bag — never carries the apiKey (ST-1 typed column):
   *  the secret never crosses the wire; `hasStoredApiKey` reports its
   *  existence instead. */
  config: Record<string, unknown>;
  /** True when the typed api_key column holds a non-empty key. */
  hasStoredApiKey: boolean;
  /** Provider profile name whose endpoint auto-matches this profile
   *  (default-on key reuse) - UI hint only. */
  autoKeyProviderName: string | null;
  /** ST-7 capability seam — the client reads it to surface the emotion
   *  toggle; v1 pure-ASR backends force it off. */
  emotionAnnotation: boolean;
  /** The fallback pointer — at most one profile carries it. */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SttTranscribeResult {
  text: string;
  language?: string;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function listAllSttProfiles(): Promise<SttProfileRecord[]> {
  const response = await client.api.stt.profiles.all.$get();
  return unwrapRpc<SttProfileRecord[]>(response);
}

export async function getSttProfile(id: string): Promise<SttProfileRecord | null> {
  const response = await client.api.stt.profiles[":id"].$get({ param: { id } });
  if (response.status === 404) return null;
  return unwrapRpc<SttProfileRecord>(response);
}

export async function createSttProfile(body: {
  name: string;
  backend: string;
  config?: Record<string, unknown>;
  /** Write-only API key (ST-1): non-empty = set, absent = none. Never
   *  returned by a read. */
  apiKey?: string;
  emotionAnnotation?: boolean;
  isDefault?: boolean;
}): Promise<SttProfileRecord> {
  const response = await client.api.stt.profiles.$post({ json: body as never });
  return unwrapRpc<SttProfileRecord>(response);
}

export async function updateSttProfile(
  id: string,
  body: Partial<{
    name: string;
    backend: string;
    config: Record<string, unknown>;
    /** Write-only tri-state (ST-1): undefined = keep, "" = clear,
     *  non-empty = set. */
    apiKey: string;
    emotionAnnotation: boolean;
    isDefault: boolean;
  }>,
): Promise<SttProfileRecord> {
  const response = await client.api.stt.profiles[":id"].$patch({ param: { id }, json: body as never });
  return unwrapRpc<SttProfileRecord>(response);
}

export async function deleteSttProfile(id: string): Promise<void> {
  const response = await client.api.stt.profiles[":id"].$delete({ param: { id } });
  if (!response.ok) throw await unwrapError(response);
}

export async function setSttDefault(id: string): Promise<SttProfileRecord> {
  const response = await client.api.stt.profiles[":id"].default.$put({ param: { id } });
  return unwrapRpc<SttProfileRecord>(response);
}

export async function getDefaultSttProfile(): Promise<SttProfileRecord | null> {
  const response = await client.api.stt.profiles.default.$get();
  if (response.status === 404) return null;
  return unwrapRpc<SttProfileRecord>(response);
}

// ─── Transcription (raw fetch, mobile-token aware) ───────────────────────────

/** Transcribe an audio Blob with a saved profile. Server-side key
 *  resolution applies (own key, then endpoint auto-match over provider and
 *  TTS profiles) — the secret never crosses the wire. */
export async function transcribeSttAudio(
  profileId: string,
  blob: Blob,
  language?: string,
): Promise<SttTranscribeResult> {
  const baseUrl = getGatewayBaseUrl();
  const form = new FormData();
  form.append("audio", blob, "audio");
  form.append("profileId", profileId);
  if (language !== undefined && language !== "") {
    form.append("language", language);
  }
  const response = await fetch(appendTokenQuery(`${baseUrl}/api/stt/transcribe`), {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`STT transcribe failed: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return (await response.json()) as SttTranscribeResult;
}

// ─── Local server discovery (raw fetch, ST-8) ──────────────────────────────

/** Local STT server discovery, routed through the API server (ST-8): local
 *  servers may ship no CORS headers, so the browser cannot probe them
 *  directly — the server-side fetch can (mirror of discoverLocalTtsServers
 *  in tts-api.ts). */
export async function discoverLocalSttServers(): Promise<import("@vibe-tavern/domain").ProbeOutcome[]> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(appendTokenQuery(`${baseUrl}/api/stt/discover`));
  if (!response.ok) {
    throw new Error(`Local STT discovery failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as import("@vibe-tavern/domain").ProbeOutcome[];
}
// ─── Live model discovery (P8 — fetched picker for every listable backend) ──

/** One entry of the live STT model catalog — the wire twin of the backend
 *  SttModelInfo: OpenAI-compatible aggregators enrich entries (isFree /
 *  description); the Gemini catalogue maps names to bare ids. */
export interface SttModelListEntry {
  id: string;
  label: string;
  isFree?: boolean;
  description?: string;
}

/** Transient draft request over the CURRENT form config (P8) — mirror of
 *  listTtsDraftModels in tts-api.ts: the form's just-typed key rides INSIDE
 *  the config (formDraftConfig), profileId lets the server inject the stored
 *  typed-column key for a matching endpoint. */
export async function listSttDraftModels(body: {
  backend: string;
  config: Record<string, unknown>;
  profileId?: string;
}): Promise<SttModelListEntry[]> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(appendTokenQuery(`${baseUrl}/api/stt/draft/models`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`STT draft model list failed: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return (await response.json()) as SttModelListEntry[];
}
