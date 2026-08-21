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
 * Source sync (RM-12e): built-in rows are APP-OWNED CONTENT and mirror the
 * catalog — when the shipped source changes, a restart re-syncs the seeded
 * rows (visual source, script code, names) instead of leaving the app serving
 * a stale copy from the database. This is a mirror, not an upsert-everything:
 * bindings, scope, and enabled flags are only SET on first create. A user
 * wanting a customized variant duplicates the built-in and edits the copy.
 * (The original create-or-return behavior shipped a stale Catch visual for an
 * entire debugging session before anyone noticed — that class of bug dies
 * here.)
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
  /** Entry ids whose seeded rows were RE-SYNCED to the catalog this run. */
  readonly updated: readonly string[];
  /** Entry ids that threw, with the error message — never aborts the batch. */
  readonly skipped: readonly { readonly id: string; readonly error: string }[];
  /** Entry ids skipped because the user dismissed the built-in (tombstone). */
  readonly dismissed: readonly string[];
}

/**
 * Ensure every built-in experience's script + visual exist. Safe to call on
 * every startup. Returns a summary for the caller to log.
 */
export async function seedBuiltinExperiences(stores: StoreContainer): Promise<BuiltinSeedResult> {
  const seeded: string[] = [];
  const updated: string[] = [];
  const skipped: Array<{ id: string; error: string }> = [];
  const dismissed: string[] = [];

  for (const entry of BUILTIN_EXPERIENCE_CATALOG) {
    try {
      // Fix item 12: respect the user's explicit removal of a built-in — skip
      // ensure + re-bind entirely so a restart never resurrects it.
      if (await stores.experienceResources.isBuiltinExperienceDismissed(entry.id)) {
        dismissed.push(entry.id);
        continue;
      }
      if (await seedOneBuiltin(stores, entry)) {
        updated.push(entry.id);
      }
      seeded.push(entry.id);
    } catch (error) {
      skipped.push({
        id: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { seeded, updated, skipped, dismissed };
}

/** Ensure a single built-in's visual + script, wired via defaultVisualId.
 *  Returns true when an already-seeded row was re-synced to the catalog. */
async function seedOneBuiltin(
  stores: StoreContainer,
  entry: BuiltinExperienceEntry,
): Promise<boolean> {
  let synced = false;

  // 1. Visual first — its id is needed for the script's defaultVisualId.
  let visual = await stores.experienceResources.ensureVisualByKey(entry.visualStableKey, {
    name: entry.displayName,
    source: entry.visualSource,
    apiVersion: 1,
    compatibleManifestIds: [entry.manifestId],
    scopeType: "global",
  });
  // Source sync: app-owned rows mirror the catalog (see the header comment).
  if (visual.source !== entry.visualSource || visual.name !== entry.displayName) {
    visual = await stores.experienceResources.updateVisual(visual.id, {
      name: entry.displayName,
      source: entry.visualSource,
      compatibleManifestIds: [entry.manifestId],
    });
    synced = true;
  }

  // 2. Interactive script — idempotent via creationIntentId "builtin:<id>".
  //    enabled + global + builtinId so it is playable app-wide and identifiable
  //    by the UI; defaultVisualId wires the pair.
  let script = await stores.scripts.create({
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
  // Source sync for the rules side (same mirror semantics as the visual).
  if (script.code !== entry.rulesSource || script.name !== entry.displayName) {
    script = await stores.scripts.update(script.id, {
      name: entry.displayName,
      description: entry.description,
      code: entry.rulesSource,
    });
    synced = true;
  }

  // 3. Bind the visual into the script's bound set (BE-5). Idempotent — the
  //    default is already set above so bindVisual will not change it. On a
  //    fresh DB this creates the junction row so "primary ∈ bound set" holds;
  //    on a re-seed it is a no-op (composite-PK conflict is ignored).
  await stores.scripts.bindVisual(script.id, visual.id);

  return synced;
}
