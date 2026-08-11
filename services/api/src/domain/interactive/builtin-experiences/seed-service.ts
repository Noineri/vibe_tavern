/**
 * Built-in experience seed service (BE-3).
 *
 * Idempotently ensures every entry in `BUILTIN_EXPERIENCE_CATALOG` exists as an
 * app-owned interactive script + visual pair, wired together via the script's
 * `defaultVisualId`. Designed to run once per server startup (BE-4), after
 * migrations + store-container creation.
 *
 * Idempotency:
 *  - Visual: `ensureVisualByKey(stableKey)` (BE-2) — create-or-return by the
 *    stable key, so a restart never duplicates the visual.
 *  - Script: `scripts.create({ creationIntentId: "builtin:<id>" })` — the
 *    script store returns the existing row for a duplicate intent instead of
 *    creating a second copy.
 *
 * This is create-or-return, NOT upsert: a re-seed with changed source does not
 * overwrite an already-seeded built-in (source-sync-on-app-update is a later
 * concern; the conversation built-in is stable for V1). The first seed sets the
 * script's `defaultVisualId`, `enabled: true`, `scopeType: "global"`, and
 * `extensions.builtinId` (+ `builtin: true`) so the UI can identify it.
 *
 * A single entry failing never aborts the rest: failures are collected in
 * `skipped` and the caller (BE-4) logs them — startup is never crashed by a
 * bad built-in.
 */
import type { StoreContainer } from "@vibe-tavern/db";

import { BUILTIN_EXPERIENCE_CATALOG, type BuiltinExperienceEntry } from "./index.js";

/** Outcome of seeding the whole catalog. */
export interface BuiltinSeedResult {
  /** Entry ids that were ensured (created or already present), in catalog order. */
  readonly seeded: readonly string[];
  /** Entry ids that threw, with the error message — never aborts the batch. */
  readonly skipped: readonly { readonly id: string; readonly error: string }[];
}

/**
 * Ensure every built-in experience's script + visual exist. Safe to call on
 * every startup. Returns a summary for the caller to log.
 */
export async function seedBuiltinExperiences(stores: StoreContainer): Promise<BuiltinSeedResult> {
  const seeded: string[] = [];
  const skipped: Array<{ id: string; error: string }> = [];

  for (const entry of BUILTIN_EXPERIENCE_CATALOG) {
    try {
      await seedOneBuiltin(stores, entry);
      seeded.push(entry.id);
    } catch (error) {
      skipped.push({
        id: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { seeded, skipped };
}

/** Ensure a single built-in's visual + script, wired via defaultVisualId. */
async function seedOneBuiltin(
  stores: StoreContainer,
  entry: BuiltinExperienceEntry,
): Promise<void> {
  // 1. Visual first — its id is needed for the script's defaultVisualId.
  const visual = await stores.experienceResources.ensureVisualByKey(entry.visualStableKey, {
    name: entry.displayName,
    source: entry.visualSource,
    apiVersion: 1,
    compatibleManifestIds: [entry.manifestId],
    scopeType: "global",
  });

  // 2. Interactive script — idempotent via creationIntentId "builtin:<id>".
  //    enabled + global + builtinId so it is playable app-wide and identifiable
  //    by the UI; defaultVisualId wires the pair.
  await stores.scripts.create({
    name: entry.displayName,
    description: entry.description,
    code: entry.rulesSource,
    scriptKind: "interactive",
    enabled: true,
    creationIntentId: `builtin:${entry.id}`,
    scopeType: "global",
    defaultVisualId: visual.id,
    extensions: { builtinId: entry.id, builtin: true },
  });
}
