import { describe, test, expect } from "bun:test";
import {
  getCoauthorModule,
  getCoauthorModules,
  isSeedModule,
  getSeedModuleDefs,
  DEFAULT_COAUTHOR_MODULE_ID,
} from "../src/domain/coauthor/modules/module-registry.js";
import type { CoauthorModule } from "@vibe-tavern/api-contracts";

/** A user-module row shape (what the store returns; no isBuiltIn, has timestamps). */
function userModule(id: string): Omit<CoauthorModule, "isBuiltIn"> & { createdAt: string; updatedAt: string } {
  return {
    id,
    name: `User ${id}`,
    description: "custom",
    basePrompt: "user prompt text",
    openingMessage: "user opening",
    skillIds: ["general-writing"],
    toolSet: { write_profile: true },
    maxSteps: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("Coauthor Module Registry — seed resolution", () => {
  test("getCoauthorModules returns seed modules with inline basePrompt loaded from disk + isBuiltIn", async () => {
    const modules = await getCoauthorModules();
    expect(modules.length).toBeGreaterThanOrEqual(3);
    const def = modules[0];
    expect(def.id).toBe(DEFAULT_COAUTHOR_MODULE_ID);
    // basePrompt is now INLINE TEXT loaded from the .md asset (not a file path).
    expect(def.basePrompt.length).toBeGreaterThan(0);
    expect(def.basePrompt).not.toContain("coauthor/modules/"); // not a path
    expect(def.isBuiltIn).toBe(true);
    // openingMessage is seeded on chat birth (CS-29); every seed defines one.
    expect(def.openingMessage.length).toBeGreaterThan(0);
  });

  test("getCoauthorModule resolves a seed id with inline basePrompt + isBuiltIn", async () => {
    const mod = await getCoauthorModule("profile-editor");
    expect(mod.id).toBe("profile-editor");
    expect(mod.isBuiltIn).toBe(true);
    expect(mod.basePrompt.length).toBeGreaterThan(0);
  });

  test("getCoauthorModule falls back to default when id is not found (and no user modules)", async () => {
    const mod = await getCoauthorModule("non-existent-module");
    expect(mod.id).toBe(DEFAULT_COAUTHOR_MODULE_ID);
  });

  test("getCoauthorModule falls back to default for null/undefined/empty id", async () => {
    expect((await getCoauthorModule(null)).id).toBe(DEFAULT_COAUTHOR_MODULE_ID);
    expect((await getCoauthorModule(undefined)).id).toBe(DEFAULT_COAUTHOR_MODULE_ID);
    expect((await getCoauthorModule("")).id).toBe(DEFAULT_COAUTHOR_MODULE_ID);
  });
});

describe("Coauthor Module Registry — CED-2 paired write_* tool scopes", () => {
  test("write_* tools are scoped per seed module (only where the matching edit_* is allowed)", () => {
    const byId = new Map(getSeedModuleDefs().map((m) => [m.id, m.toolSet]));

    // Character Workshop (default): all three write_* tools (it can edit everything).
    const def = byId.get("default")!;
    expect(def.write_personality).toBe(true);
    expect(def.write_scenario).toBe(true);
    expect(def.write_examples).toBe(true);

    // Revision Workshop (profile-editor): PERSONALITY/SCENARIO writes only (mirrors
    // its edit_* scope); must NOT reach EXAMPLES.
    const editor = byId.get("profile-editor")!;
    expect(editor.write_personality).toBe(true);
    expect(editor.write_scenario).toBe(true);
    expect(editor.write_examples).toBeUndefined();
    expect(editor.edit_examples).toBeUndefined();

    // Dialogue Studio (dialogue-writer): EXAMPLES write only; must NOT reach PERSONALITY/SCENARIO.
    const dialogue = byId.get("dialogue-writer")!;
    expect(dialogue.write_examples).toBe(true);
    expect(dialogue.write_personality).toBeUndefined();
    expect(dialogue.write_scenario).toBeUndefined();
    expect(dialogue.edit_personality).toBeUndefined();
  });

  test("quick-draft seed (CTX-M2) carries the full card-building toolSet + greeting tools", () => {
    // Quick Draft builds a complete card from scratch: it needs write_profile for
    // the ground-up build plus the greeting tools for the opener. It is additive
    // (new seed id); the three original seed ids are preserved.
    const byId = new Map(getSeedModuleDefs().map((m) => [m.id, m.toolSet]));
    const qd = byId.get("quick-draft")!;
    expect(qd).toBeDefined();
    expect(qd.write_profile).toBe(true);
    expect(qd.write_personality).toBe(true);
    expect(qd.write_scenario).toBe(true);
    expect(qd.write_examples).toBe(true);
    expect(qd.edit_greeting).toBe(true);
    expect(qd.add_alt_greeting).toBe(true);
    // The three original seed ids survive (existing chats need no migration).
    expect(isSeedModule("default")).toBe(true);
    expect(isSeedModule("profile-editor")).toBe(true);
    expect(isSeedModule("dialogue-writer")).toBe(true);
    expect(isSeedModule("quick-draft")).toBe(true);
  });
});

describe("Coauthor Module Registry — seed + user merge (CS-24)", () => {
  test("getCoauthorModules merges seed (first, isBuiltIn) + user (appended, isBuiltIn:false)", async () => {
    const modules = await getCoauthorModules([userModule("u1"), userModule("u2")]);
    const seedCount = (await getCoauthorModules()).length;
    expect(modules.length).toBe(seedCount + 2);
    // Seed modules keep isBuiltIn=true; user modules are isBuiltIn=false.
    expect(modules.slice(0, seedCount).every((m) => m.isBuiltIn === true)).toBe(true);
    const userMods = modules.slice(seedCount);
    expect(userMods.every((m) => m.isBuiltIn === false)).toBe(true);
    expect(userMods.map((m) => m.id)).toEqual(["u1", "u2"]);
    // User timestamps are dropped in the API shape.
    expect(userMods[0]).not.toHaveProperty("createdAt");
    expect(userMods[0]).not.toHaveProperty("updatedAt");
  });

  test("getCoauthorModule resolves a USER id from the passed user-modules list (no DB read for seeds)", async () => {
    const mod = await getCoauthorModule("u1", [userModule("u1")]);
    expect(mod.id).toBe("u1");
    expect(mod.isBuiltIn).toBe(false);
    expect(mod.basePrompt).toBe("user prompt text");
  });

  test("getCoauthorModule falls back to default when a user id is not in the list", async () => {
    const mod = await getCoauthorModule("deleted-user-module", [userModule("u1")]);
    expect(mod.id).toBe(DEFAULT_COAUTHOR_MODULE_ID);
    expect(mod.isBuiltIn).toBe(true);
  });

  test("seed-first resolution: a seed id resolves even when userModules is empty (hot-path optimization)", async () => {
    const mod = await getCoauthorModule("default", []);
    expect(mod.id).toBe("default");
    expect(mod.isBuiltIn).toBe(true);
  });
});

describe("Coauthor Module Registry — introspection helpers", () => {
  test("isSeedModule identifies built-in ids (no I/O)", () => {
    expect(isSeedModule("default")).toBe(true);
    expect(isSeedModule("profile-editor")).toBe(true);
    expect(isSeedModule("dialogue-writer")).toBe(true);
    expect(isSeedModule("u1")).toBe(false);
    expect(isSeedModule(null)).toBe(false);
    expect(isSeedModule(undefined)).toBe(false);
    expect(isSeedModule("")).toBe(false);
  });

  test("getSeedModuleDefs returns defs with a basePromptFile (not inline text — loaded lazily)", () => {
    const defs = getSeedModuleDefs();
    expect(defs.length).toBeGreaterThanOrEqual(3);
    expect(defs[0].basePromptFile).toMatch(/coauthor\/modules\/.+\.md/);
    expect(defs.every((d) => d.openingMessage.length >= 0)).toBe(true);
  });
});
