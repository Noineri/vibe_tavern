import { z } from "zod";

/**
 * A profile's OWN model choice (DIRECTOR_MODE_PLAN DR-2 / owner ruling
 * 2026-10-25, M1 — see DIRECTOR_MODE_PLAN.md) — the model a profile's turns
 * run on in every chat when set. Absent = same as sidechat (the existing
 * chain:
 * the kind's remembered binding → the kind's per-kind fallback → the first
 * profile). Addressed per (agent kind, profile id) because built-in seed ids
 * are kind-scoped; valid for built-ins and user profiles alike — the model is
 * a SETTING, not an edit (the read-only guard protects a built-in's prompt
 * and tools only). The provider link is soft (no FK): a dangling id falls
 * through to the existing chain at turn time, never an error.
 */
export const agentProfileModelSchema = z
  .object({
    providerProfileId: z.string().min(1),
    /** null = the provider's default model (resolved at turn time). */
    modelName: z.string().min(1).nullable(),
  })
  .strict();
export type AgentProfileModelWire = z.infer<typeof agentProfileModelSchema>;

/** Body for `PUT /api/agent/kinds/:kind/profiles/:profileId/model`: a whole
 *  binding (set/replace), never a merge — clearing is the DELETE route.
 *  `.strict()` rejects unknown keys (the api-contracts norm). `modelName`
 *  absent or null pins the provider's default model. */
export const agentProfileModelPutSchema = z
  .object({
    providerProfileId: z.string().min(1),
    modelName: z.string().min(1).nullable().optional(),
  })
  .strict();
export type AgentProfileModelPutRequest = z.infer<typeof agentProfileModelPutSchema>;
