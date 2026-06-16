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
