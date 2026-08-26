import type {
  ServicePromptProfile,
  ServicePromptProfileListResponse,
  ServicePromptProfileDetailResponse,
  CreateServicePromptProfileRequest,
  UpdateServicePromptProfileRequest,
} from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";

export type { ServicePromptProfile, ServicePromptProfileListResponse, ServicePromptProfileDetailResponse };

export async function listServicePromptProfiles(): Promise<ServicePromptProfileListResponse> {
  const response = await client.api["service-prompts"].profiles.$get();
  return unwrapRpc<ServicePromptProfileListResponse>(response);
}

export async function getServicePromptProfileDetail(id: string): Promise<ServicePromptProfileDetailResponse | null> {
  const response = await client.api["service-prompts"].profiles[":id"].$get({ param: { id } });
  if (response.status === 404) return null;
  return unwrapRpc<ServicePromptProfileDetailResponse>(response);
}

export async function createServicePromptProfile(
  body: CreateServicePromptProfileRequest,
): Promise<ServicePromptProfile> {
  const response = await client.api["service-prompts"].profiles.$post({ json: body });
  return unwrapRpc<ServicePromptProfile>(response);
}

export async function updateServicePromptProfile(
  id: string,
  body: UpdateServicePromptProfileRequest,
): Promise<ServicePromptProfile> {
  const response = await client.api["service-prompts"].profiles[":id"].$patch({ param: { id }, json: body });
  if (!response.ok) throw await unwrapError(response);
  return unwrapRpc<ServicePromptProfile>(response);
}

export async function deleteServicePromptProfile(id: string): Promise<void> {
  const response = await client.api["service-prompts"].profiles[":id"].$delete({ param: { id } });
  if (!response.ok) throw await unwrapError(response);
}

export async function setActiveServicePromptProfile(profileId: string | null): Promise<void> {
  const response = await client.api["service-prompts"].active.$put({ json: { profileId } });
  if (!response.ok) throw await unwrapError(response);
}
