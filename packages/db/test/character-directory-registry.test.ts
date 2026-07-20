import { describe, expect, test } from "bun:test";
import { mkdtemp, rename as fsRename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContentStore } from "../src/content-store.js";
import { createFileStore, STORAGE_FOLDERS } from "../src/file-store.js";
import {
  CharacterDirectoryRegistry,
  DuplicateStorageIdError,
} from "../src/stores/character-directory-registry.js";
import { serializeProfileMd } from "../src/vtf/profile-md.js";
import type { VtfProfile } from "../src/vtf/profile-md.js";

const CHARS = STORAGE_FOLDERS.characters;

/** A minimal valid profile.md body so serializeProfileMd produces real text. */
function minimalProfile(): VtfProfile {
  return {
    name: "X",
    tags: [],
    creator: null,
    characterVersion: null,
    creatorNotes: null,
    mesExampleMode: "always",
    mesExampleDepth: 4,
    description: "desc",
    scenario: null,
    mesExample: null,
  };
}

async function setup(): Promise<{
  dataRoot: string;
  content: ContentStore;
  registry: CharacterDirectoryRegistry;
}> {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-reg-test-"));
  const content = new ContentStore({ fileStore: createFileStore(dataRoot) });
  const registry = new CharacterDirectoryRegistry(content);
  return { dataRoot, content, registry };
}

/** Write a character directory with a profile.md stamping the given storage_id. */
async function writeCharDir(
  content: ContentStore,
  dirName: string,
  storageId: string | null,
): Promise<void> {
  const profileText =
    storageId !== null
      ? serializeProfileMd({ profile: minimalProfile(), storageId })
      : serializeProfileMd({ profile: minimalProfile() });
  await content.writeEntityTextFile(CHARS, dirName, "profile.md", profileText);
}

describe("CharacterDirectoryRegistry", () => {
  // ─── Clean scan + resolve ──────────────────────────────────────────────

  test("init scans profile.md storage_id and resolves characterId → directory", async () => {
    const { content, registry } = await setup();
    await writeCharDir(content, "Andrea", "char_1");
    await writeCharDir(content, "Oliver", "char_2");

    await registry.init();

    expect(await registry.resolve("char_1")).toBe("Andrea");
    expect(await registry.resolve("char_2")).toBe("Oliver");
  });

  test("resolve triggers a scan on first call when init was not called", async () => {
    const { content, registry } = await setup();
    await writeCharDir(content, "Andrea", "char_1");
    // No init() — resolve lazily scans.
    expect(await registry.resolve("char_1")).toBe("Andrea");
  });

  test("resolve returns null for an unknown characterId (after rescan)", async () => {
    const { registry } = await setup();
    await registry.init();
    expect(await registry.resolve("char_nonexistent")).toBeNull();
  });

  // ─── Legacy fallback (no storage_id) ───────────────────────────────────

  test("a directory without storage_id is mapped by its own name (legacy fallback)", async () => {
    const { content, registry } = await setup();
    // Pre-migration opaque-id dir: no storage_id, dir name == characterId.
    await writeCharDir(content, "char_legacy", null);

    await registry.init();

    // resolve by the dir name (which IS the legacy characterId).
    expect(await registry.resolve("char_legacy")).toBe("char_legacy");
  });

  test("a directory with no profile.md at all is still mapped by name (legacy card.json-only)", async () => {
    const { content, registry } = await setup();
    // A pre-VTF dir with only a card.json (no profile.md → no storage_id).
    await content.writeEntityFile(CHARS, "char_cardonly", "card", { name: "Old" });

    await registry.init();

    expect(await registry.resolve("char_cardonly")).toBe("char_cardonly");
  });

  test("identified (by storage_id) overrides legacy (by name) on a key collision", async () => {
    const { content, registry } = await setup();
    // Mid-state: an old opaque dir (no id) + a migrated dir claiming char_1.
    await writeCharDir(content, "char_1", null); // legacy, name == char_1
    await writeCharDir(content, "Andrea", "char_1"); // identified
    await registry.init();
    // The migrated directory wins — char_1 resolves to Andrea, not the stale
    // old-name folder.
    expect(await registry.resolve("char_1")).toBe("Andrea");
  });

  // ─── Duplicate storage_id ──────────────────────────────────────────────

  test("duplicate storage_id across two directories throws DuplicateStorageIdError", async () => {
    const { content, registry } = await setup();
    await writeCharDir(content, "Andrea", "char_dup");
    await writeCharDir(content, "Andrea-copy", "char_dup");

    await expect(registry.init()).rejects.toBeInstanceOf(DuplicateStorageIdError);
    try {
      await registry.scan();
    } catch (e) {
      expect(e).toBeInstanceOf(DuplicateStorageIdError);
      const err = e as DuplicateStorageIdError;
      expect(err.storageId).toBe("char_dup");
      expect(err.directories.sort()).toEqual(["Andrea", "Andrea-copy"]);
    }
  });

  // ─── Rescan-on-miss + out-of-band rename recovery ──────────────────────

  test("a character written after init is found via rescan-on-miss", async () => {
    const { content, registry } = await setup();
    await registry.init(); // empty
    // Write a new character dir AFTER init.
    await writeCharDir(content, "Newcomer", "char_new");

    // resolve triggers one rescan and discovers it by storage_id.
    expect(await registry.resolve("char_new")).toBe("Newcomer");
  });

  test("out-of-band directory rename is recovered: resolve rescans and rediscovers by storage_id", async () => {
    const { dataRoot, content, registry } = await setup();
    await writeCharDir(content, "char_1", "char_1"); // dir name == id, stamped
    await registry.init();
    expect(await registry.resolve("char_1")).toBe("char_1");

    // Simulate an out-of-band rename (user renamed the dir in their file browser).
    // The profile.md (with storage_id: char_1) moves with the directory.
    await fsRename(join(dataRoot, CHARS, "char_1"), join(dataRoot, CHARS, "Andrea"));

    // The mapped path (char_1) no longer exists → resolve rescans → rediscovers
    // the character by storage_id under its new name.
    expect(await registry.resolve("char_1")).toBe("Andrea");
  });

  // ─── renameDirectory ───────────────────────────────────────────────────

  test("renameDirectory moves the folder and updates the in-memory map", async () => {
    const { content, registry } = await setup();
    await writeCharDir(content, "char_1", "char_1");
    await registry.init();

    await registry.renameDirectory("char_1", "Andrea");

    expect(await registry.resolve("char_1")).toBe("Andrea");
    // The directory physically moved.
    expect(await content.entityFolderExists(CHARS, "char_1")).toBe(false);
    expect(await content.entityFolderExists(CHARS, "Andrea")).toBe(true);
    // profile.md survived the move (still stamped with char_1).
    const profile = await content.readEntityTextFile(CHARS, "Andrea", "profile.md");
    expect(profile).toContain("storage_id: char_1");
  });

  test("renameDirectory is a no-op when old == new", async () => {
    const { content, registry } = await setup();
    await writeCharDir(content, "char_1", "char_1");
    await registry.init();

    await registry.renameDirectory("char_1", "char_1");
    expect(await content.entityFolderExists(CHARS, "char_1")).toBe(true);
  });

  test("renameDirectory rejects an occupied destination (collision safety)", async () => {
    const { content, registry } = await setup();
    await writeCharDir(content, "char_1", "char_1");
    await writeCharDir(content, "Andrea", "char_other");
    await registry.init();

    await expect(registry.renameDirectory("char_1", "Andrea")).rejects.toThrow(/destination already exists/);
    // Source untouched.
    expect(await content.entityFolderExists(CHARS, "char_1")).toBe(true);
    // Map unchanged.
    expect(await registry.resolve("char_1")).toBe("char_1");
  });

  test("renameDirectory throws when the character has no directory", async () => {
    const { registry } = await setup();
    await registry.init();
    await expect(registry.renameDirectory("char_ghost", "Andrea")).rejects.toThrow(/no directory/);
  });

  // ─── Non-deletion of orphans ───────────────────────────────────────────

  test("orphan/unidentified directories are never deleted by scan or resolve", async () => {
    const { content, registry } = await setup();
    // A dir with a profile.md that has no storage_id and doesn't match any real
    // character — the registry maps it by name but must not remove it.
    await writeCharDir(content, "mystery_dir", null);
    await registry.init();
    await registry.resolve("anything"); // trigger a rescan path too
    expect(await content.entityFolderExists(CHARS, "mystery_dir")).toBe(true);
  });
});
