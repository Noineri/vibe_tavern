import { z } from "zod";

/**
 * Script-safety settings as sent to the client (GET response).
 *
 * Server-side singleton (SCRIPT_SAFETY_PLAN decision 3): one "don't show
 * again" flag for the imported-script warning flow, shared across all
 * devices. `updatedAt` is server-managed and mirrors the stored singleton's
 * `updated_at` — it follows the package's wire-record convention of exposing
 * the store's server-managed timestamp (see `ProviderQuotaRecord.updatedAt`,
 * `AiInstructionTemplate.updatedAt`). The store returns `""` while no row
 * exists yet, so this is a plain string, not a canonical UTC instant.
 */
export const scriptSafetySettingsSchema = z.object({
  suppressImportWarnings: z.boolean(),
  updatedAt: z.string(),
});

export type ScriptSafetySettings = z.infer<typeof scriptSafetySettingsSchema>;

/**
 * PUT body for script-safety settings. `updatedAt` is deliberately absent —
 * it is server-managed and stamped on every write (mirrors
 * `updateTrackerConfigSchema` omitting `revision`/`schemaHash`).
 */
export const updateScriptSafetySettingsSchema = z.object({
  suppressImportWarnings: z.boolean(),
});

export type UpdateScriptSafetySettings = z.infer<typeof updateScriptSafetySettingsSchema>;
