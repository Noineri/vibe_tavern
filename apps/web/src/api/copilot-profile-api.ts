/**
 * Typed RPC client for the copilot profile endpoints
 * (EXPERIENCE_COPILOT_PROFILES_PLAN, Wave 3). Mirrors the co-author module
 * client (`coauthor-module-api.ts` listCoauthorModules/…) but against
 * `client.api.copilot.profiles…`. Assignment (which profile an experience uses)
 * rides the existing script-update path: `scripts.copilot_profile_id` is a
 * soft link, and `null` = "use the built-in seed" (the resolver's fallback).
 */
import type {
  AgentProfileModelPutRequest,
  AgentProfileModelWire,
  CopilotProfile,
  CopilotProfileCreate,
  CopilotProfileUpdate,
} from "@vibe-tavern/api-contracts";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";
import { updateScript } from "./script-api.js";

/** `GET /api/copilot/profiles?kind=` — the requested kind's built-in seed
 *  first, then that kind's user profiles (AS-8b: the kind param is required —
 *  the modal must never show another kind's profiles). */
export async function listCopilotProfiles(kind: string): Promise<CopilotProfile[]> {
  const response = await client.api.copilot.profiles.$get({ query: { kind } });
  const data = await unwrapRpc(response);
  return data.profiles;
}

/** `POST /api/copilot/profiles` — create a user profile. */
export async function createCopilotProfile(input: CopilotProfileCreate): Promise<CopilotProfile> {
  const response = await client.api.copilot.profiles.$post({ json: input });
  return unwrapRpc(response);
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
  return unwrapRpc(response);
}

/** `PATCH /api/copilot/profiles/reorder?kind=` — rewrite ONE kind's user
 *  profiles' manual list order (ML-6). Mirrors `reorderCoauthorModules'`
 *  payload ({ updates: [{ id, sortOrder }] } via PATCH) with the kind riding
 *  the query param, like `listCopilotProfiles`; the response is the refreshed
 *  merged list — the same envelope `listCopilotProfiles` unwraps. */
export async function reorderCopilotProfiles(
  kind: string,
  updates: Array<{ id: string; sortOrder: number }>,
): Promise<CopilotProfile[]> {
  const response = await client.api.copilot.profiles.reorder.$patch({ query: { kind }, json: { updates } });
  const data = await unwrapRpc(response);
  return data.profiles;
}

/** `DELETE /api/copilot/profiles/:profileId` — delete a user profile (built-in id → 400). */
export async function deleteCopilotProfile(profileId: string): Promise<void> {
  const response = await client.api.copilot.profiles[":profileId"].$delete({
    param: { profileId },
  });
  if (!response.ok) throw await unwrapError(response);
}

/**
 * DR-2 (owner ruling M1): a profile's own model — the `agent_profile_models`
 * row addressed per (agent kind, profile id), served by the same route family
 * as the profile CRUD above (built-in seed ids included — the model is a
 * SETTING, not an edit; the read-only guard protects prompt/tools only).
 * Absent = same as sidechat (the existing chain).
 */

/** `GET /api/agent/kinds/:kind/profiles/:profileId/model` — the stored
 *  binding, or null when the profile has no own model (same as sidechat). */
export async function getCopilotProfileModel(
  kind: string,
  profileId: string,
): Promise<AgentProfileModelWire | null> {
  const response = await client.api.agent.kinds[":kind"].profiles[":profileId"].model.$get({
    param: { kind, profileId },
  });
  const data = await unwrapRpc(response);
  return data.model ?? null;
}

/** `PUT …/model` — set/replace the WHOLE binding (never a merge; clearing is
 *  the DELETE below). `modelName` omitted/null pins the provider's default
 *  model, resolved at turn time. Returns the stored row. */
export async function setCopilotProfileModel(
  kind: string,
  profileId: string,
  input: AgentProfileModelPutRequest,
): Promise<AgentProfileModelWire> {
  const response = await client.api.agent.kinds[":kind"].profiles[":profileId"].model.$put({
    param: { kind, profileId },
    json: input,
  });
  return unwrapRpc(response).then((data) => data.model);
}

/** `DELETE …/model` — clear the binding (back to same as sidechat). Idempotent. */
export async function clearCopilotProfileModel(
  kind: string,
  profileId: string,
): Promise<void> {
  const response = await client.api.agent.kinds[":kind"].profiles[":profileId"].model.$delete({
    param: { kind, profileId },
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
