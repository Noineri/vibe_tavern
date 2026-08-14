/**
 * Typed RPC client for the copilot profile endpoints
 * (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3). Mirrors the co-author module
 * client (`chat-api.ts` listCoauthorModules/…) but against
 * `client.api.copilot.profiles…`. Assignment (which profile an experience uses)
 * rides the existing script-update path: `scripts.copilot_profile_id` is a
 * soft link, and `null` = "use the built-in seed" (the resolver's fallback).
 */
import type {
  CopilotProfile,
  CopilotProfileCreate,
  CopilotProfileUpdate,
} from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";
import { updateScript } from "./script-api.js";

/** `GET /api/copilot/profiles` — built-in seed first, then user profiles. */
export async function listCopilotProfiles(): Promise<CopilotProfile[]> {
  const response = await client.api.copilot.profiles.$get();
  const data = await unwrapRpc<{ profiles: CopilotProfile[] }>(response);
  return data.profiles;
}

/** `POST /api/copilot/profiles` — create a user profile. */
export async function createCopilotProfile(input: CopilotProfileCreate): Promise<CopilotProfile> {
  const response = await client.api.copilot.profiles.$post({ json: input });
  return unwrapRpc<CopilotProfile>(response);
}

/** `PATCH /api/copilot/profiles/:profileId` — partial update (built-in id → 400). */
export async function updateCopilotProfile(
  profileId: string,
  input: CopilotProfileUpdate,
): Promise<CopilotProfile> {
  const response = await client.api.copilot.profiles[":profileId"].$patch({
    param: { profileId },
    json: input,
  });
  return unwrapRpc<CopilotProfile>(response);
}

/** `DELETE /api/copilot/profiles/:profileId` — delete a user profile (built-in id → 400). */
export async function deleteCopilotProfile(profileId: string): Promise<void> {
  const response = await client.api.copilot.profiles[":profileId"].$delete({
    param: { profileId },
  });
  if (!response.ok) throw await unwrapError(response);
}

/**
 * Assign (or unassign) a copilot profile to an experience. `profileId === null`
 * clears the soft link so the resolver falls back to the built-in seed — the
 * "unassign" action in the profile editor selects the built-in profile and
 * writes null (storing "builtin" explicitly would be a dangling id, resolved
 * identically but never written).
 */
export async function setCopilotProfile(
  scriptId: string,
  profileId: string | null,
): Promise<void> {
  await updateScript(scriptId, { copilotProfileId: profileId });
}
