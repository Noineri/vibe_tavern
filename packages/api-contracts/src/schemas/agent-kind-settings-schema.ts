import { z } from "zod";

/**
 * Per-agent-kind settings wire contracts (SIDECHAT_PLAN SC-0d) — the
 * `GET/PATCH /api/agent/kinds/:kind/settings` routes and the bootstrap
 * payload's per-kind map.
 *
 * The kind's remembered model binding (provider profile + model name) and
 * the kind's default copilot profile (SC-0f's column: stored here, consumed
 * by SC-0f's stream profile resolution). All pointers follow the
 * ui_settings dangling-id policy: nullable, no FK — a dangling id resolves
 * with a fallback at the consumer, never a blocked delete. No invented
 * limits (the kind id and ids are opaque registry/store keys).
 */

/** One kind's effective settings — the GET/PATCH response body and one entry
 *  of the bootstrap payload's per-kind map. Nullable fields are `null`,
 *  never `undefined`. */
export const agentKindSettingsSchema = z
  .object({
    agentKind: z.string(),
    providerProfileId: z.string().nullable(),
    modelName: z.string().nullable(),
    defaultProfileId: z.string().nullable(),
    updatedAt: z.string(),
  })
  .strict();
export type AgentKindSettingsWire = z.infer<typeof agentKindSettingsSchema>;

/** Body for `PATCH /api/agent/kinds/:kind/settings`: only the fields present
 *  are written (absent keeps the stored value, `null` clears it). `.strict()`
 *  rejects unknown keys (the api-contracts norm). */
export const agentKindSettingsPatchSchema = z
  .object({
    providerProfileId: z.string().nullable().optional(),
    modelName: z.string().nullable().optional(),
    defaultProfileId: z.string().nullable().optional(),
  })
  .strict();
export type AgentKindSettingsPatchRequest = z.infer<typeof agentKindSettingsPatchSchema>;
