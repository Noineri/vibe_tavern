import type { TtsTargetType } from "@vibe-tavern/domain";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";
import { getGatewayBaseUrl } from "../gateway-client.js";
import { appendTokenQuery } from "../lib/mobile-token.js";

// ─── Wire record shapes (mirrors the backend domain TtsProfile/TtsProfileLink) ─

export interface TtsProfileRecord {
  id: string;
  name: string;
  backend: string;
  config: Record<string, unknown>;
  voiceId: string;
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
}

export interface TtsVoiceRecord {
  id: string;
  label: string;
  lang: string;
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
  voiceId?: string;
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
    voiceId: string;
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
  links: Array<{ targetType: TtsTargetType; targetId: string }>,
): Promise<TtsLinkRecord[]> {
  const response = await client.api.tts.profiles[":id"].links.$put({
    param: { id },
    json: { links },
  });
  return unwrapRpc<TtsLinkRecord[]>(response);
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
