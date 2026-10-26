/**
 * A profile's own model (DIRECTOR_MODE_PLAN DR-2 / owner ruling 2026-10-25,
 * M1 — see DIRECTOR_MODE_PLAN.md) — the resolution hop extracted from
 * `agent-stream.ts` at the arch-gate size cap.
 *
 * The owner's precedence chain, ONE line: the resolved profile's own model
 * when set → the request's pair (the kind binding the client derived through
 * the web hook: kind settings → the host's per-kind fallback → the first
 * profile) → the provider's default model. With NO stored own model every
 * kind resolves exactly as before this hop existed — the only server-side
 * addition is this hop, consulted BEFORE the provider resolution because the
 * provider inputs must resolve before any destructive write (AP-9).
 *
 * The binding is stored per (agent kind, profile id) in `agent_profile_models`
 * — built-in seed ids included ("builtin", "builtin-director", … are
 * kind-scoped code seeds, never rows). The provider link is soft (no FK): a
 * DANGLING provider id falls through to the request's pair here — the house
 * dangling-id policy, the same rule the profile chains apply to deleted
 * profile ids — never an error.
 */

import type { AgentStreamDeps } from "./agent-stream.js";

/** A profile's own model choice: the provider profile the profile's turns run
 *  on + the model (null = the provider's default model, resolved at turn
 *  time — the binding owns the WHOLE pair, so a null model never means "keep
 *  the request's model on the own provider"). */
export interface AgentOwnModelBinding {
  readonly providerProfileId: string;
  readonly modelName: string | null;
}

/**
 * Resolve the turn's own-model hop: the profile's stored binding when one
 * exists AND its provider still resolves; null otherwise (nothing stored, the
 * seam unwired, or a dangling provider — the last falls through to the
 * request's pair, the existing chain). `resolveOwnModel` is the kind stream's
 * optional seam over the `agent_profile_models` store; `getProviderProfile`
 * is the generic loop's own provider lookup, so the dangling check and the
 * provider resolution read the same source.
 */
export async function resolveTurnOwnModel<PROFILE>(
  profile: PROFILE,
  deps: Pick<AgentStreamDeps, "getProviderProfile">,
  resolveOwnModel: ((profile: PROFILE) => Promise<AgentOwnModelBinding | null>) | undefined,
): Promise<AgentOwnModelBinding | null> {
  if (resolveOwnModel === undefined) return null;
  const binding = await resolveOwnModel(profile);
  if (binding === null) return null;
  // Dangling provider (the row was deleted) — the house dangling-id policy:
  // fall through to the request's pair (the chain), never error.
  if ((await deps.getProviderProfile(binding.providerProfileId)) === null) return null;
  return binding;
}
