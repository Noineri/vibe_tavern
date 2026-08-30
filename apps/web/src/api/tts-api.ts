import type { ProbeOutcome, TtsTargetType } from "@vibe-tavern/domain";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";
import { getGatewayBaseUrl } from "../gateway-client.js";
import { appendTokenQuery } from "../lib/mobile-token.js";

// ─── Wire record shapes (mirrors the backend domain TtsProfile/TtsProfileLink) ─

export interface TtsProfileRecord {
  id: string;
  name: string;
  backend: string;
  /** Backend-specific bag — never carries the apiKey (TE2-16 typed column):
   *  the secret never crosses the wire; `hasStoredApiKey` reports its
   *  existence instead. */
  config: Record<string, unknown>;
  /** True when the typed api_key column holds a non-empty key. */
  hasStoredApiKey: boolean;
  /** Optional providerProfiles.id link — key + baseUrl resolve server-side
   *  at synthesis/test time (TE2-16); never carries a secret either. */
  providerRef: string | null;
  /** Provider profile name whose endpoint auto-matches this profile
   *  (default-on key reuse) - UI hint only. */
  autoKeyProviderName: string | null;
  voiceId: string;
  narratorVoiceId: string | null;
  lang: string;
  sortOrder: number;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TtsLinkRecord {
  ttsProfileId: string;
  targetType: TtsTargetType;
  targetId: string;
  /** 'voice' | 'disabled' — omitted-by-old-servers tolerant default: treat
   *  missing as 'voice' when reading raw JSON. */
  mode?: "voice" | "disabled";
}

export interface TtsVoiceRecord {
  id: string;
  label: string;
  lang: string;
}

/** Backend capability hints for the profile editor (clone field design
 *  2026-08-31). Mirrors the server's TtsBackendCapabilities. */
export interface TtsBackendCapabilities {
  supportsCloning: boolean;
  formats?: string[];
  maxSizeMb?: number;
}

/** Draft-voices response envelope: capabilities ride alongside voices —
 *  voices may be null (empty library) while cloning is still available. */
export interface TtsDraftVoicesResponse {
  voices: TtsVoiceRecord[] | null;
  capabilities: TtsBackendCapabilities;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function listAllTtsProfiles(): Promise<TtsProfileRecord[]> {
  const response = await client.api.tts.profiles.all.$get();
  return unwrapRpc<TtsProfileRecord[]>(response);
}

export async function getTtsProfile(id: string): Promise<TtsProfileRecord | null> {
  const response = await client.api.tts.profiles[":id"].$get({ param: { id } });
  if (response.status === 404) return null;
  return unwrapRpc<TtsProfileRecord>(response);
}

export async function createTtsProfile(body: {
  name: string;
  backend: string;
  config?: Record<string, unknown>;
  /** Write-only API key (TE2-16): non-empty = set, absent = none. Never
   *  returned by a read. */
  apiKey?: string;
  /** Optional providerProfiles.id link (server-side key resolution). */
  providerRef?: string;
  voiceId?: string;
  narratorVoiceId?: string | null;
  lang?: string;
  sortOrder?: number;
  isDefault?: boolean;
}): Promise<TtsProfileRecord> {
  const response = await client.api.tts.profiles.$post({ json: body as never });
  return unwrapRpc<TtsProfileRecord>(response);
}

export async function updateTtsProfile(
  id: string,
  body: Partial<{
    name: string;
    backend: string;
    config: Record<string, unknown>;
    /** Write-only tri-state (TE2-16): undefined = keep, "" = clear,
     *  non-empty = set. */
    apiKey: string;
    providerRef: string;
    voiceId: string;
    narratorVoiceId: string | null;
    lang: string;
    sortOrder: number;
    isDefault: boolean;
  }>,
): Promise<TtsProfileRecord> {
  const response = await client.api.tts.profiles[":id"].$patch({ param: { id }, json: body as never });
  return unwrapRpc<TtsProfileRecord>(response);
}

export async function deleteTtsProfile(id: string): Promise<void> {
  const response = await client.api.tts.profiles[":id"].$delete({ param: { id } });
  if (!response.ok) throw await unwrapError(response);
}

export async function setTtsDefault(id: string): Promise<TtsProfileRecord> {
  const response = await client.api.tts.profiles[":id"].default.$put({ param: { id } });
  return unwrapRpc<TtsProfileRecord>(response);
}

export async function getDefaultTtsProfile(): Promise<TtsProfileRecord | null> {
  const response = await client.api.tts.profiles.default.$get();
  if (response.status === 404) return null;
  return unwrapRpc<TtsProfileRecord>(response);
}

// ─── Links (voice map) ───────────────────────────────────────────────────────

export async function getTtsLinks(id: string): Promise<TtsLinkRecord[]> {
  const response = await client.api.tts.profiles[":id"].links.$get({ param: { id } });
  return unwrapRpc<TtsLinkRecord[]>(response);
}

export async function setTtsLinks(
  id: string,
  links: Array<{ targetType: TtsTargetType; targetId: string; mode?: "voice" | "disabled" }>,
): Promise<TtsLinkRecord[]> {
  const response = await client.api.tts.profiles[":id"].links.$put({
    param: { id },
    json: { links },
  });
  return unwrapRpc<TtsLinkRecord[]>(response);
}

export async function listAllTtsLinks(): Promise<Array<TtsLinkRecord & { mode: "voice" | "disabled" }>> {
  const response = await client.api.tts.links.$get();
  const raw = await unwrapRpc<TtsLinkRecord[]>(response);
  return raw.map((r) => ({ ...r, mode: r.mode ?? "voice" }));
}

// ─── Binary generation + voices (raw fetch, mobile-token aware) ──────────────

/**
 * Generate speech for a TTS profile. Returns a Blob + mime (the server sends a
 * single buffered audio response per paragraph — paragraph-level streaming
 * already delivers low latency, so byte-level SSE is unnecessary).
 */
export async function generateTtsSpeech(body: {
  profileId: string;
  text: string;
  speed?: number;
  instructions?: string;
  voiceId?: string;
}): Promise<{ blob: Blob; mime: string }> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(appendTokenQuery(`${baseUrl}/api/tts/generate`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`TTS generate failed: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const mime = response.headers.get("content-type") ?? "audio/mpeg";
  const blob = await response.blob();
  return { blob, mime };
}

export async function listTtsVoices(profileId: string): Promise<TtsVoiceRecord[]> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(
    appendTokenQuery(`${baseUrl}/api/tts/profiles/${encodeURIComponent(profileId)}/voices`),
  );
  if (response.status === 404) return [];
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`TTS voice list failed: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return (await response.json()) as TtsVoiceRecord[];
}

// ─── Draft (transient) check — unsaved form config ─────────────────────────

/** Voices for a config straight from the profile-editor form — no saved
 *  profile needed. The apiKey inside `config` is transient (used once for
 *  this request); when it is empty and `profileId` names the saved profile
 *  this form belongs to (same backend/endpoint), the server injects the
 *  STORED key for this one request (strip-on-read UX). Kokoro is rejected
 *  by the server (browser-only) — callers gate on the backend first.
 *  Response envelope carries capabilities for the clone section. */
export async function listTtsDraftVoices(body: {
  backend: string;
  config: Record<string, unknown>;
  profileId?: string;
}): Promise<TtsDraftVoicesResponse> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(appendTokenQuery(`${baseUrl}/api/tts/draft/voices`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`TTS draft voice list failed: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return (await response.json()) as TtsDraftVoicesResponse;
}

/** Clone a voice from the profile-editor form (multipart passthrough; the
 *  audio passes through server memory and is never stored). Same transient
 *  config semantics as listTtsDraftVoices. */
export async function cloneTtsVoice(body: {
  backend: string;
  config: Record<string, unknown>;
  profileId?: string;
  name: string;
  audio: File;
}): Promise<TtsVoiceRecord> {
  const baseUrl = getGatewayBaseUrl();
  const form = new FormData();
  form.append("backend", body.backend);
  form.append("config", JSON.stringify(body.config));
  if (body.profileId !== undefined) form.append("profileId", body.profileId);
  form.append("name", body.name);
  form.append("audio", body.audio);
  const response = await fetch(appendTokenQuery(`${baseUrl}/api/tts/clone`), {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = `TTS voice clone failed: ${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (typeof parsed.error === "string" && parsed.error.length > 0) message = parsed.error;
    } catch {
      if (text) message += `: ${text.slice(0, 200)}`;
    }
    throw new Error(message);
  }
  return (await response.json()) as TtsVoiceRecord;
}

export async function listTtsDraftModels(body: {
  backend: string;
  config: Record<string, unknown>;
  profileId?: string;
}): Promise<TtsModelListEntry[]> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(appendTokenQuery(`${baseUrl}/api/tts/draft/models`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`TTS draft model list failed: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return (await response.json()) as TtsModelListEntry[];
}

/** One entry of the draft model list — aggregator enrichment
 *  (isFree / description / contextLength / voices) is parsed server-side
 *  when the provider ships it (OpenRouter-style /models payloads; the
 *  per-model voice roster rides aggregator catalogs, D22). */
export interface TtsModelListEntry {
  id: string;
  label: string;
  isFree?: boolean;
  description?: string;
  contextLength?: number;
  voices?: string[];
}

// ─── Local-server helpers (D8) ───────────────────────────────────────────

/** Server-side docker availability probe — `docker --version` via the API
 *  server (bounded, never throws server-side); degrades to
 *  `{available:false, version:null}` when the CLI is missing or hung. */
export async function fetchLocalDockerStatus(): Promise<{ available: boolean; version: string | null }> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(appendTokenQuery(`${baseUrl}/api/tts/local/docker`));
  if (!response.ok) {
    throw new Error(`Docker probe failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as { available: boolean; version: string | null };
}

/** Local TTS server discovery, routed through the API server: some local
 *  servers (openai-edge-tts) ship no CORS headers, so the browser cannot
 *  probe them directly — the server-side fetch can (same seam as the docker
 *  probe above). */
export async function discoverLocalTtsServers(): Promise<ProbeOutcome[]> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(appendTokenQuery(`${baseUrl}/api/tts/local/discover`));
  if (!response.ok) {
    throw new Error(`Local TTS discovery failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as ProbeOutcome[];
}

/** One-shot preview synthesis from an unsaved form config — the
 *  "Прослушать голос" path for server backends BEFORE saving. */
export async function previewTtsDraft(body: {
  backend: string;
  config: Record<string, unknown>;
  profileId?: string;
  voiceId: string;
  text: string;
  speed?: number;
  instructions?: string;
}): Promise<{ blob: Blob; mime: string }> {
  const baseUrl = getGatewayBaseUrl();
  const response = await fetch(appendTokenQuery(`${baseUrl}/api/tts/draft/preview`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`TTS draft preview failed: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const mime = response.headers.get("content-type") ?? "audio/mpeg";
  const blob = await response.blob();
  return { blob, mime };
}
