import type { ChatId } from "@vibe-tavern/domain";
import type { AppSnapshot, PersonaRecord } from "./types.js";
import { client, getGatewayBaseUrl, getMobileToken } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";
import { normalizeSnapshot } from "./normalize.js";

export async function listPersonas(): Promise<PersonaRecord[]> {
  const response = await client.api.personas.$get();
  return unwrapRpc<PersonaRecord[]>(response);
}

export async function createPersona(input: {
  name: string;
  description: string;
  pronouns?: string | null;
  defaultForNewChats?: boolean;
}): Promise<PersonaRecord> {
  const response = await client.api.personas.$post({ json: input });
  return unwrapRpc<PersonaRecord>(response);
}

export async function updatePersona(
  personaId: string,
  input: {
    chatId?: ChatId;
    name: string;
    description: string;
    pronouns?: string | null;
    avatarAssetId?: string | null;
    avatarFullAssetId?: string | null;
    avatarCropJson?: string | null;
    // Avatar-appearance prompt injection (MEDIA_GALLERY).
    includeAvatarInPrompt?: boolean;
    avatarDescription?: string | null;
  },
): Promise<AppSnapshot> {
  const response = await client.api.personas[":personaId"].$patch({ param: { personaId }, json: input });
  const data = await unwrapRpc<AppSnapshot>(response);
  if (!data.character) return data;
  return normalizeSnapshot(data);
}

export async function deletePersona(personaId: string): Promise<void> {
  const response = await client.api.personas[":personaId"].$delete({ param: { personaId } });
  if (!response.ok) throw await unwrapError(response);
}

export async function duplicatePersona(personaId: string): Promise<PersonaRecord> {
  const response = await client.api.personas[":personaId"].duplicate.$post({ param: { personaId } });
  return unwrapRpc<PersonaRecord>(response);
}

export async function setDefaultPersona(personaId: string): Promise<void> {
  await client.api.personas[":personaId"]["set-default"].$post({ param: { personaId } });
}

/**
 * Upload an avatar to the persona's entity folder (POST /api/personas/:id/avatar).
 * `crop` is the thumbnail ({id}/avatar.{ext}); `full` (optional, uncropped
 * source) is written to {id}/avatar-full.{ext}. See uploadCharacterAvatar.
 */
export async function uploadPersonaAvatar(personaId: string, crop: File, full?: File): Promise<{ avatarExt: string; avatarFullExt: string | null }> {
  const formData = new FormData();
  formData.append("crop", crop);
  if (full) formData.append("full", full);
  const baseUrl = getGatewayBaseUrl();
  const token = getMobileToken();
  const response = await fetch(`${baseUrl}/api/personas/${personaId}/avatar`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: formData,
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Avatar upload failed (${response.status}): ${errorBody}`);
  }
  return response.json();
}

// ─── Export / Import (PR-5) ─────────────────────────────────────────────────
// Mirrors ST's backup/restore UX: one self-contained JSON per download, one
// file pick to restore. `format=st` is interop with SillyTavern (lossy: drops
// VT-only fields); `format=vt` is lossless round-trip.

function todayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** Fetch a single persona export and trigger a browser download. */
export async function exportPersona(personaId: string, format: "st" | "vt"): Promise<void> {
  const baseUrl = getGatewayBaseUrl();
  const token = getMobileToken();
  const response = await fetch(`${baseUrl}/api/personas/${personaId}/export?format=${format}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) throw new Error(`Persona export failed (${response.status})`);
  triggerDownload(await response.text(), `persona_${todayStamp()}.json`);
}

/** Fetch a bulk export (all personas) and trigger a browser download. */
export async function exportAllPersonas(format: "st" | "vt"): Promise<void> {
  const baseUrl = getGatewayBaseUrl();
  const token = getMobileToken();
  const response = await fetch(`${baseUrl}/api/personas/export?format=${format}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) throw new Error(`Bulk export failed (${response.status})`);
  triggerDownload(await response.text(), `personas_${todayStamp()}.json`);
}

/** Restore a previously-exported VT/ST file. Returns the per-persona result summary. */
export async function importPersonas(file: File): Promise<{ created: number; skipped: number; errors: string[] }> {
  const baseUrl = getGatewayBaseUrl();
  const token = getMobileToken();
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { created: 0, skipped: 0, errors: ["File is not valid JSON"] };
  }
  const response = await fetch(`${baseUrl}/api/personas/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(parsed),
  });
  if (!response.ok) throw new Error(`Persona import failed (${response.status})`);
  return response.json();
}

function triggerDownload(text: string, filename: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
