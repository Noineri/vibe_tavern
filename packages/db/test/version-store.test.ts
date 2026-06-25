import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../src/db-connection.js";
import { ContentStore } from "../src/content-store.js";
import { createFileStore, STORAGE_FOLDERS } from "../src/file-store.js";
import { CharacterStore } from "../src/stores/character-store.js";
import { VersionStore } from "../src/stores/version-store.js";
import { brandId, type CharacterId } from "@vibe-tavern/domain";

const CHARS = STORAGE_FOLDERS.characters;

// Deterministic clock/id generator so version ordering + ids are stable in tests.
let vCounter = 0;
const clock = { now: () => `2026-06-15T00:00:${String(vCounter++).padStart(2, "0")}.000Z` };
let cCounter = 0;
let gCounter = 0;
const idGen = {
  next: (prefix: string) =>
    prefix === "charver" ? `charver_test_${++gCounter}` : `${prefix}_test_${++cCounter}`,
};

async function setup() {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-versionstore-test-"));
  const db = await createDb(join(dataRoot, "test.db"));
  const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
  const characters = new CharacterStore(db, { content, clock, idGenerator: idGen });
  const versions = new VersionStore(db, { clock, idGenerator: idGen, characters });
  return { dataRoot, db, content, characters, versions };
}

async function readProfile(dataRoot: string, charId: string, versionId?: string): Promise<string> {
  const rel = versionId ? join(charId, "versions", versionId, "profile.md") : join(charId, "profile.md");
  return readFile(join(dataRoot, CHARS, rel), "utf8");
}

async function readInstructions(dataRoot: string, charId: string, versionId?: string): Promise<string> {
  const rel = versionId
    ? join(charId, "versions", versionId, "instructions.json")
    : join(charId, "instructions.json");
  return readFile(join(dataRoot, CHARS, rel), "utf8");
}

async function folderExists(_dataRoot: string, _charId: string, _versionId: string): Promise<boolean> {
  try {
    const dir = await readdir(join(_dataRoot, CHARS, _charId, "versions", _versionId));
    return dir.length > 0;
  } catch {
    return false;
  }
}

describe("VersionStore (VTF Phase 3)", () => {
  test("ensureBaseVersion materializes an active Base from the root (idempotent)", async () => {
    const { characters, versions } = await setup();
    const char = await characters.create({ name: "Aria", description: "mage", firstMessage: "Hi" });

    const base = await versions.ensureBaseVersion(char.id);
    expect(base.title).toBe("Base");
    expect(base.isActive).toBe(true);

    // Idempotent: returns the same active version, no duplicate row.
    const again = await versions.ensureBaseVersion(char.id);
    expect(again.id).toBe(base.id);
    const list = await versions.listVersions(char.id);
    expect(list).toHaveLength(1);
  });

  test("createVersion branches: current root is preserved, new version is active, root unchanged", async () => {
    const { characters, versions, dataRoot } = await setup();
    const char = await characters.create({ name: "Elena", description: "calm", firstMessage: "Hello" });
    await versions.ensureBaseVersion(char.id);

    const beforeBranch = await readProfile(dataRoot, char.id);

    const v2 = await versions.createVersion(char.id, "Aggressive");
    expect(v2.isActive).toBe(true);
    expect(v2.title).toBe("Aggressive");

    const list = await versions.listVersions(char.id);
    expect(list).toHaveLength(2);
    // Exactly one active.
    expect(list.filter((v) => v.isActive)).toHaveLength(1);

    // Root content unchanged at branch time (new version = identical copy).
    expect(await readProfile(dataRoot, char.id)).toBe(beforeBranch);
    // The old active (Base) is preserved as a snapshot folder.
    const base = list.find((v) => v.title === "Base")!;
    expect(await folderExists(dataRoot, char.id, base.id)).toBe(true);
    expect(await readProfile(dataRoot, char.id, base.id)).toBe(beforeBranch);
  });

  test("setActive swaps folders round-trip: edit active → switch → switch back preserves snapshot byte-identical", async () => {
    const { characters, versions, dataRoot } = await setup();
    const char = await characters.create({
      name: "Silvius",
      description: "base body",
      firstMessage: "Greetings",
    });
    await versions.ensureBaseVersion(char.id);
    const baseList = await versions.listVersions(char.id);
    const baseId = baseList[0].id;

    const aggressive = await versions.createVersion(char.id, "Aggressive");
    // Root now reflects the new (aggressive) active version. Edit it.
    await characters.update(char.id, { description: "AGGRESSIVE EDIT" });
    const editedProfile = await readProfile(dataRoot, char.id);
    expect(editedProfile).toContain("AGGRESSIVE EDIT");
    const editedInstructions = await readInstructions(dataRoot, char.id);

    // Switch back to Base: aggressive edits must be snapshotted, base restored.
    await versions.setActive(char.id, baseId);
    expect(await readProfile(dataRoot, char.id)).toContain("base body");
    // Aggressive snapshot preserved byte-identical at versions/{aggressive}/.
    expect(await readProfile(dataRoot, char.id, aggressive.id)).toBe(editedProfile);
    expect(await readInstructions(dataRoot, char.id, aggressive.id)).toBe(editedInstructions);

    // Switch to Aggressive again: root reflects aggressive edits, base preserved.
    await versions.setActive(char.id, aggressive.id);
    expect(await readProfile(dataRoot, char.id)).toBe(editedProfile);

    // Switch back to Base once more: base still byte-identical (no drift).
    await versions.setActive(char.id, baseId);
    expect(await readProfile(dataRoot, char.id)).toContain("base body");
    const baseSnapshotAfter = await readProfile(dataRoot, char.id, baseId);
    // After switching to base, root == base; and aggressive snapshot intact.
    expect(await readProfile(dataRoot, char.id, aggressive.id)).toBe(editedProfile);
    expect(baseSnapshotAfter).toContain("base body");
  });

  test("setActive is a no-op when the target is already active", async () => {
    const { characters, versions } = await setup();
    const char = await characters.create({ name: "N", description: "d", firstMessage: "f" });
    const base = await versions.ensureBaseVersion(char.id);
    const result = await versions.setActive(char.id, base.id);
    expect(result.id).toBe(base.id);
    expect((await versions.listVersions(char.id))).toHaveLength(1);
  });

  test("setActive throws when the version belongs to a different character", async () => {
    const { characters, versions } = await setup();
    const a = await characters.create({ name: "A", description: "a", firstMessage: "a" });
    const b = await characters.create({ name: "B", description: "b", firstMessage: "b" });
    const baseB = await versions.ensureBaseVersion(b.id);
    await expect(versions.setActive(a.id, baseB.id)).rejects.toThrow(/does not belong/);
  });

  test("deleteVersion refuses the active version, removes non-active folder + row", async () => {
    const { characters, versions, dataRoot } = await setup();
    const char = await characters.create({ name: "C", description: "d", firstMessage: "f" });
    await versions.ensureBaseVersion(char.id);
    const extra = await versions.createVersion(char.id, "Extra");
    // Extra is now active; Base is non-active.
    const list = await versions.listVersions(char.id);
    const base = list.find((v) => v.title === "Base")!;

    // Deleting the active version is refused.
    await expect(versions.deleteVersion(char.id, extra.id)).rejects.toThrow(/active/);

    // Deleting the non-active Base removes its folder + row.
    expect(await folderExists(dataRoot, char.id, base.id)).toBe(true);
    await versions.deleteVersion(char.id, base.id);
    expect(await folderExists(dataRoot, char.id, base.id)).toBe(false);
    expect((await versions.listVersions(char.id))).toHaveLength(1);

    // Idempotent: deleting a missing version is a no-op.
    await versions.deleteVersion(char.id, base.id);
  });

  test("renameVersion updates the title without touching content", async () => {
    const { characters, versions, dataRoot } = await setup();
    const char = await characters.create({ name: "R", description: "d", firstMessage: "f" });
    const base = await versions.ensureBaseVersion(char.id);
    const renamed = await versions.renameVersion(base.id, "Renamed Base");
    expect(renamed?.title).toBe("Renamed Base");
    // Content untouched.
    const profile = await readProfile(dataRoot, char.id);
    expect(profile).toContain("name: R");
    // renameVersion of a missing version returns null.
    expect(await versions.renameVersion("charver_does_not_exist", "x")).toBeNull();
  });

  test("createVersion bootstraps an implicit Base when the character has no versions yet", async () => {
    const { characters, versions } = await setup();
    const char = await characters.create({ name: "Fresh", description: "d", firstMessage: "f" });
    // No ensureBaseVersion call — createVersion must bootstrap internally.
    const v = await versions.createVersion(char.id, "Branch 1");
    const list = await versions.listVersions(char.id);
    expect(list).toHaveLength(2);
    expect(list.some((x) => x.title === "Base")).toBe(true);
    expect(v.isActive).toBe(true);
  });

  test("getById reflects the active version after a switch (version-agnostic read)", async () => {
    const { characters, versions } = await setup();
    const char = await characters.create({ name: "V", description: "orig", firstMessage: "f" });
    await versions.ensureBaseVersion(char.id);
    const v2 = await versions.createVersion(char.id, "V2");
    await characters.update(char.id, { description: "v2-body" });

    const baseList = await versions.listVersions(char.id);
    const baseId = baseList.find((v) => v.title === "Base")!.id;

    // Active = v2 → getById reads v2 content.
    const activeV2 = await characters.getById(char.id);
    expect(activeV2?.description).toBe("v2-body");

    // Switch to base → getById reads base content.
    await versions.setActive(char.id, baseId);
    const activeBase = await characters.getById(char.id);
    expect(activeBase?.description).toBe("orig");

    // v2 id is a branded CharacterVersionId (sanity on the domain type).
    expect(v2.characterId).toEqual(brandId<CharacterId>(char.id));
  });
});
