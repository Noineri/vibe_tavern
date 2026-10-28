/**
 * A profile's own model, client side (DIRECTOR_MODE_PLAN DR-2/DR-8 — the
 * `agent_profile_models` rows the API serves per (agent kind, profile id)).
 *
 * The ONE cache and the ONE derivation every consumer reads: the binding hook
 * (`use-agent-model-binding.ts` — the composer's pills/caption/write
 * redirect), the settings summary's model-row subtitle, and the profiles
 * modal's model block (the `agent_profile_model_label` row). Consumers render, never re-derive — a second
 * hand-written resolution of "does this profile have an own model" is a §3
 * defect from copy #2.
 *
 * Writes are OPTIMISTIC (the cache flips immediately, so every subscribed
 * surface follows the same frame) and revert + rethrow on failure — the caller
 * surfaces the toast. Loads are idempotent per key (in-flight dedupe) and
 * leave the key absent on failure, so a transient error reads as "no own
 * model" (the today-chain) until the next `load` succeeds.
 *
 * The dangling-provider rule mirrors the server's `agent-own-model.ts`: a
 * binding whose provider row no longer exists falls through to the request
 * pair — `resolveAgentProfileOwnModel` returns null for it, never an error.
 */
import { create } from "zustand";
import type { AgentProfileModelPutRequest, AgentProfileModelWire } from "@vibe-tavern/api-contracts";
import type { ProviderProfileRecord } from "../api/types.js";
import {
  clearCopilotProfileModel,
  getCopilotProfileModel,
  setCopilotProfileModel,
} from "../api/copilot-profile-api.js";

/** Cache key — the same (kind, profile id) pair the API addresses rows by. */
export function agentProfileModelKey(kind: string, profileId: string): string {
  return `${kind}:${profileId}`;
}

export interface AgentProfileModelState {
  /** Stored bindings by `${kind}:${profileId}`; null = no own model. An
   *  ABSENT key means "not loaded yet" — consumers read it only through
   *  `resolveAgentProfileOwnModel`, which treats absent as null. */
  models: Record<string, AgentProfileModelWire | null>;
}

export interface AgentProfileModelActions {
  /** Fetch one (kind, profile) binding (no-op while a load for the same key
   *  is in flight or the key is already cached). Never rejects. */
  load: (kind: string, profileId: string) => Promise<void>;
  /** Set/replace the whole binding (PUT), optimistically. Rejects (with the
   *  cache reverted) when the server refuses the write. */
  set: (kind: string, profileId: string, input: AgentProfileModelPutRequest) => Promise<void>;
  /** Clear the binding (DELETE), optimistically. Rejects (with the cache
   *  reverted) when the server refuses the write. */
  clear: (kind: string, profileId: string) => Promise<void>;
}

export type AgentProfileModelStore = AgentProfileModelState & AgentProfileModelActions;

/** In-flight loads by key — `load` is fire-and-forget from effects, so two
 *  consumers mounting together must not double-fetch the same row. */
const inflight: Record<string, Promise<void>> = {};

export const useAgentProfileModelStore = create<AgentProfileModelStore>()((set, get) => ({
  models: {},

  load: async (kind, profileId) => {
    const key = agentProfileModelKey(kind, profileId);
    if (get().models[key] !== undefined || inflight[key] !== undefined) return;
    const request = (async () => {
      try {
        const model = await getCopilotProfileModel(kind, profileId);
        // Only adopt the fresh read when no optimistic write raced it — a
        // write's own cache update is newer than this GET's snapshot.
        if (get().models[key] !== undefined) return;
        set({ models: { ...get().models, [key]: model } });
      } catch {
        // Leave the key absent (reads as "no own model") — the next load retries.
      } finally {
        delete inflight[key];
      }
    })();
    inflight[key] = request;
    await request;
  },

  set: async (kind, profileId, input) => {
    const key = agentProfileModelKey(kind, profileId);
    const prev = get().models[key];
    const optimistic: AgentProfileModelWire = {
      providerProfileId: input.providerProfileId,
      modelName: input.modelName ?? null,
    };
    set({ models: { ...get().models, [key]: optimistic } });
    try {
      const model = await setCopilotProfileModel(kind, profileId, input);
      set({ models: { ...get().models, [key]: model } });
    } catch (error) {
      set({ models: { ...get().models, [key]: prev } });
      throw error;
    }
  },

  clear: async (kind, profileId) => {
    const key = agentProfileModelKey(kind, profileId);
    const prev = get().models[key];
    set({ models: { ...get().models, [key]: null } });
    try {
      await clearCopilotProfileModel(kind, profileId);
    } catch (error) {
      set({ models: { ...get().models, [key]: prev } });
      throw error;
    }
  },
}));

/**
 * The effective own-model binding for a (kind, profile) — ONE derivation for
 * every consumer: a stored row whose PROVIDER still resolves, else null.
 * Absent/unloaded keys and dangling providers read as null (the today-chain),
 * mirroring the server's precedence hop (`agent-own-model.ts`): the profile's
 * own model only wins when it actually can.
 */
export function resolveAgentProfileOwnModel(
  kind: string,
  profileId: string | null | undefined,
  providerProfiles: ProviderProfileRecord[],
  models: Record<string, AgentProfileModelWire | null>,
): AgentProfileModelWire | null {
  if (profileId === null || profileId === undefined) return null;
  const binding = models[agentProfileModelKey(kind, profileId)];
  if (binding === undefined || binding === null) return null;
  // Dangling provider (the provider row was deleted): fall through to the
  // request pair, never error — the house dangling-id policy.
  if (!providerProfiles.some((p) => p.id === binding.providerProfileId)) return null;
  return binding;
}
