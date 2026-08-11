/**
 * Built-in experience seed service (BE-3).
 *
 * Proves `seedBuiltinExperiences` is idempotent against a real temp
 * StoreContainer (real SQLite, real stores — no mocks): seed twice → exactly
 * one Conversation script + one visual, the script enabled + global + carrying
 * `extensions.builtinId`, `defaultVisualId` wired to the visual.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";

import { seedBuiltinExperiences } from "../src/domain/interactive/builtin-experiences/seed-service.js";
import { BUILTIN_EXPERIENCE_CATALOG } from "../src/domain/interactive/builtin-experiences/index.js";

async function setup(): Promise<StoreContainer> {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-builtin-seed-"));
  return createStoreContainer(join(dataRoot, "test.db"), dataRoot);
}

const CATALOG_IDS = BUILTIN_EXPERIENCE_CATALOG.map((entry) => entry.id);

describe("seedBuiltinExperiences (BE-3)", () => {
  test("seeds the Conversation built-in: enabled + global + builtinId + defaultVisualId wired", async () => {
    const stores = await setup();
    const result = await seedBuiltinExperiences(stores);

    expect(result.skipped).toEqual([]);
    expect(result.seeded).toEqual(CATALOG_IDS);

    const scripts = await stores.scripts.listAll();
    const convo = scripts.find((s) => s.creationIntentId === "builtin:conversation");
    expect(convo).toBeDefined();
    expect(convo!.scriptKind).toBe("interactive");
    expect(convo!.enabled).toBe(true);
    expect(convo!.scopeType).toBe("global");
    expect(convo!.extensions.builtinId).toBe("conversation");
    expect(convo!.extensions.builtin).toBe(true);
    expect(convo!.defaultVisualId).not.toBeNull();

    // The wired visual exists and resolves to the Conversation visual.
    const visual = convo!.defaultVisualId
      ? await stores.experienceResources.getVisualById(convo!.defaultVisualId)
      : null;
    expect(visual).not.toBeNull();
    expect(visual!.name).toBe("Conversation");
    expect(visual!.source).toBeTypeOf("string");
    expect(visual!.source.length).toBeGreaterThan(0);
  });

  test("is idempotent — seeding twice produces exactly one script + one visual, no duplicate", async () => {
    const stores = await setup();

    const first = await seedBuiltinExperiences(stores);
    expect(first.skipped).toEqual([]);

    const second = await seedBuiltinExperiences(stores);
    expect(second.skipped).toEqual([]);
    expect(second.seeded).toEqual(CATALOG_IDS);

    // Exactly one script for the built-in intent.
    const scripts = await stores.scripts.listAll();
    const convoScripts = scripts.filter((s) => s.creationIntentId === "builtin:conversation");
    expect(convoScripts).toHaveLength(1);

    // Exactly one global visual named Conversation (the built-in).
    const visuals = await stores.experienceResources.listVisualsForScope("global", null);
    const convoVisuals = visuals.filter((v) => v.name === "Conversation");
    expect(convoVisuals).toHaveLength(1);
  });
});
