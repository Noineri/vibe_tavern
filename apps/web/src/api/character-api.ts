import type { ChatId } from "@vibe-tavern/domain";
import type { AppSnapshot, ImportJsonResponse } from "./types.js";
import { client, getGatewayBaseUrl, getMobileToken } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";
import { normalizeSnapshot } from "./normalize.js";

export async function updateCharacter(
  characterId: string,
  input: Partial<{
    chatId?: ChatId;
    name: string;
    description: string;
    personalitySummary: string | null;
    scenario: string;
    systemPrompt: string;
    firstMessage: string | null;
    mesExample: string | null;
    mesExampleMode?: "always" | "once" | "depth";
    mesExampleDepth?: number;
    alternateGreetings: string[];
    postHistoryInstructions: string | null;
    creatorNotes: string | null;
    depthPrompt: string | null;
    depthPromptDepth: number | null;
    depthPromptRole: string | null;
    tags: string[];
    // Media gallery / avatar-appearance prompt injection (MEDIA_GALLERY).
    includeGalleryInPrompt?: boolean;
    includeAvatarInPrompt?: boolean;
    avatarDescription?: string | null;
  }>,
): Promise<AppSnapshot> {
  const response = await client.api.characters[":characterId"].$patch({ param: { characterId }, json: input });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

export async function createCharacter(input: {
  name: string;
  description?: string;
  firstMessage?: string;
  scenario?: string;
  personalitySummary?: string;
  mesExample?: string;
  alternateGreetings?: string[];
  postHistoryInstructions?: string;
  creatorNotes?: string;
  systemPrompt?: string;
  depthPrompt?: string;
  depthPromptDepth?: number;
  depthPromptRole?: string;
  tags?: string[];
}): Promise<ImportJsonResponse> {
  const response = await client.api.characters.$post({ json: input });
  const data = await unwrapRpc<ImportJsonResponse>(response);
  return { ...data, snapshot: normalizeSnapshot(data.snapshot) };
}

export async function duplicateCharacter(characterId: string): Promise<ImportJsonResponse> {
  const response = await client.api.characters[":characterId"].duplicate.$post({ param: { characterId } });
  const data = await unwrapRpc<ImportJsonResponse>(response);
  return { ...data, snapshot: normalizeSnapshot(data.snapshot) };
}

export async function archiveCharacter(characterId: string): Promise<{ characterId: string; status: "archived" }> {
  const response = await client.api.characters[":characterId"].archive.$patch({ param: { characterId } });
  return unwrapRpc<{ characterId: string; status: "archived" }>(response);
}

export async function unarchiveCharacter(characterId: string): Promise<{ characterId: string; status: "active" }> {
  const response = await client.api.characters[":characterId"].unarchive.$patch({ param: { characterId } });
  return unwrapRpc<{ characterId: string; status: "active" }>(response);
}

export async function deleteCharacter(characterId: string): Promise<void> {
  const response = await client.api.characters[":characterId"].$delete({ param: { characterId } });
  if (!response.ok) throw await unwrapError(response);
}

export async function exportCharacter(characterId: string): Promise<Record<string, unknown>> {
  const response = await client.api.characters[":characterId"].export.$get({ param: { characterId } });
  return unwrapRpc<Record<string, unknown>>(response);
}

export async function updateCharacterAvatar(
  characterId: string,
  chatId: string,
  avatarAssetId: string,
  avatarFullAssetId?: string,
  avatarCropJson?: string | null,
): Promise<AppSnapshot> {
  const payload: Record<string, unknown> = { chatId, avatarAssetId };
  if (avatarFullAssetId !== undefined) payload.avatarFullAssetId = avatarFullAssetId;
  if (avatarCropJson !== undefined) payload.avatarCropJson = avatarCropJson;
  const response = await client.api.characters[":characterId"].$patch({ param: { characterId }, json: payload });
  const data = await unwrapRpc<AppSnapshot>(response);
  return normalizeSnapshot(data);
}

/**
 * Upload an avatar to the character's entity folder (POST /api/characters/:id/avatar).
 * The backend writes {id}/avatar.{ext}, sets avatarExt, and clears the legacy
 * avatarAssetId. Returns the stored extension. The folder model stores a
 * single avatar used for all display sizes — the cropped/full distinction only
 * survives for legacy flat-asset avatars.
 */
export async function uploadCharacterAvatar(characterId: string, file: File): Promise<{ avatarExt: string }> {
  const formData = new FormData();
  formData.append("file", file);
  const baseUrl = getGatewayBaseUrl();
  const token = getMobileToken();
  const response = await fetch(`${baseUrl}/api/characters/${characterId}/avatar`, {
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
