import type {
  ImagePromptProfileValue,
  ImagePromptProfileListResponse,
  ImagePromptProfileDetailResponse,
  CreateImagePromptProfileRequest,
  UpdateImagePromptProfileRequest,
} from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";

/**
 * Image prompt profile API client (IF-1d — fork of service-prompt-api.ts for
 * the separately-living image prompt profile collection). Whole-profile save
 * semantics: PATCH sends name and/or the FULL overrides map (cell keys
 * `"rowKey|family"` → { body, qualityText }); per-cell writes do not exist.
 */

export type { ImagePromptProfileValue, ImagePromptProfileListResponse, ImagePromptProfileDetailResponse };

export async function listImagePromptProfiles(): Promise<ImagePromptProfileListResponse> {
  const response = await client.api["image-gen"]["prompt-profiles"].$get();
  return unwrapRpc(response);
}

export async function getImagePromptProfileDetail(id: string): Promise<ImagePromptProfileDetailResponse | null> {
  const response = await client.api["image-gen"]["prompt-profiles"][":id"].$get({ param: { id } });
  if (response.status === 404) return null;
  return unwrapRpc(response);
}

export async function createImagePromptProfile(
  body: CreateImagePromptProfileRequest,
): Promise<ImagePromptProfileValue> {
  const response = await client.api["image-gen"]["prompt-profiles"].$post({ json: body });
  return unwrapRpc(response);
}

export async function updateImagePromptProfile(
  id: string,
  body: UpdateImagePromptProfileRequest,
): Promise<ImagePromptProfileValue> {
  const response = await client.api["image-gen"]["prompt-profiles"][":id"].$patch({ param: { id }, json: body });
  if (!response.ok) throw await unwrapError(response);
  return unwrapRpc(response);
}

export async function deleteImagePromptProfile(id: string): Promise<void> {
  const response = await client.api["image-gen"]["prompt-profiles"][":id"].$delete({ param: { id } });
  if (!response.ok) throw await unwrapError(response);
}

export async function setActiveImagePromptProfile(profileId: string | null): Promise<void> {
  const response = await client.api["image-gen"]["prompt-profiles"].active.$put({ json: { profileId } });
  if (!response.ok) throw await unwrapError(response);
}

export async function reorderImagePromptProfiles(
  updates: Array<{ id: string; sortOrder: number }>,
): Promise<ImagePromptProfileListResponse> {
  const response = await client.api["image-gen"]["prompt-profiles"].reorder.$patch({ json: { updates } });
  if (!response.ok) throw await unwrapError(response);
  return unwrapRpc(response);
}
