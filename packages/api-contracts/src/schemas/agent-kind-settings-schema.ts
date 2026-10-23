import { z } from "zod";
import { CHAT_MODE } from "@vibe-tavern/domain";

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
    // The row's (or the legacy fallback's) `updated_at`; `null` when the kind
    // has neither a row nor the legacy fallback (SC-7: only the two pre-split
    // kinds inherit it).
    updatedAt: z.string().nullable(),
    // SC-7b (owner decision 8): the chat modes this kind's sessions serve —
    // a REGISTRY fact carried on the settings entry (never stored, never
    // patched): the server always emits the descriptor's `servesChatModes`,
    // so the wire map exists before its first web consumer (SC-13 hides the
    // sidechat panel/entry from this field, not a second hard-coded mode
    // check). Values are `CHAT_MODE`'s (the chat row's own vocabulary — the
    // same derivation the domain type uses, no second hand-typed list).
    servesChatModes: z.array(z.enum(Object.values(CHAT_MODE))),
    // AP-20: the kind's default for the auto-compact toggle on NEW sessions.
    // Non-nullable on the wire — the store resolves the stored NULL (= on,
    // the pre-AP-20 effective behavior) to `true` at read; consumed by the
    // two new-session paths when they write the thread's auto_compact.
    autoCompactDefault: z.boolean(),
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
    // AP-20: boolean only — `null` (unset) is indistinguishable from on, so
    // there is no clear form; absent keeps the stored value.
    autoCompactDefault: z.boolean().optional(),
  })
  .strict();
export type AgentKindSettingsPatchRequest = z.infer<typeof agentKindSettingsPatchSchema>;
