import { describe, expect, test } from "bun:test";
import { mkdtemp, rename as fsRename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContentStore } from "../src/content-store.js";
import { createFileStore, STORAGE_FOLDERS, type FileStore } from "../src/file-store.js";
import {
  CharacterDirectoryRegistry,
  DuplicateStorageIdError,
  sanitizeDirectoryName,
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

/** Like {@link writeCharDir} but with a custom character display name in the profile. */
function profileNamed(name: string): VtfProfile {
  return { ...minimalProfile(), name };
}

async function writeCharDirNamed(
  content: ContentStore,
  dirName: string,
  storageId: string | null,
  charName: string,
): Promise<void> {
  const profileText =
    storageId !== null
      ? serializeProfileMd({ profile: profileNamed(charName), storageId })
      : serializeProfileMd({ profile: profileNamed(charName) });
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

describe("sanitizeDirectoryName (HUMAN_READABLE_FOLDERS HRF-4)", () => {
  test("lowercases and hyphenates non-alphanumeric runs", () => {
    expect(sanitizeDirectoryName("Andrea Storm")).toBe("andrea-storm");
    expect(sanitizeDirectoryName("  Zack_Foster!! ")).toBe("zack-foster");
    expect(sanitizeDirectoryName("A.B.C")).toBe("a-b-c");
  });

  test("Windows-reserved names get a trailing hyphen", () => {
    expect(sanitizeDirectoryName("CON")).toBe("con-");
    expect(sanitizeDirectoryName("NUL")).toBe("nul-");
    expect(sanitizeDirectoryName("COM1")).toBe("com1-");
    expect(sanitizeDirectoryName("LPT9")).toBe("lpt9-");
  });

  test("caps length to 60 and trims trailing hyphens after truncation", () => {
    const result = sanitizeDirectoryName("a".repeat(100));
    expect(result.length).toBe(60);
    expect(result.endsWith("-")).toBe(false);
    expect(result).toBe("a".repeat(60));
  });

  test("a degenerate name (no alphanumerics) returns empty", () => {
    expect(sanitizeDirectoryName("!!!")).toBe("");
    expect(sanitizeDirectoryName("   ")).toBe("");
    expect(sanitizeDirectoryName("")).toBe("");
  });
});

describe("CharacterDirectoryRegistry.ensureDirectory (HRF-4)", () => {
  test("a new character reserves a human-readable name (collision-proof against a peer)", async () => {
    const { registry } = await setup();
    await registry.init();
    expect(await registry.ensureDirectory("char_1", "Andrea Storm")).toBe("andrea-storm");
    // A peer named identically is suffixed — the in-memory reservation holds
    // even though no folder exists on disk yet (the store creates it next).
    expect(await registry.ensureDirectory("char_2", "Andrea Storm")).toBe("andrea-storm-2");
  });

  test("collision suffixing against an existing directory", async () => {
    const { content, registry } = await setup();
    await writeCharDirNamed(content, "oliver", "char_a", "Oliver");
    await registry.init();
    // A NEW character named Oliver → "oliver" is taken → "oliver-2".
    expect(await registry.ensureDirectory("char_b", "Oliver")).toBe("oliver-2");
    // A third → "oliver-3".
    expect(await registry.ensureDirectory("char_c", "Oliver")).toBe("oliver-3");
  });

  test("actual filesystem occupancy is case-insensitive (Andrea occupies andrea)", async () => {
    const { content, registry } = await setup();
    // Out-of-band/legacy basenames may contain uppercase even though new app
    // candidates are lowercase. Windows treats these as the same path.
    await writeCharDirNamed(content, "Andrea", "char_a", "Andrea");
    await registry.init();
    expect(await registry.ensureDirectory("char_b", "Andrea")).toBe("andrea-2");
  });

  test("concurrent identical-name reservations serialize to distinct deterministic suffixes", async () => {
    const { registry } = await setup();
    await registry.init();
    const names = await Promise.all([
      registry.ensureDirectory("char_1", "Oliver"),
      registry.ensureDirectory("char_2", "Oliver"),
      registry.ensureDirectory("char_3", "Oliver"),
    ]);
    expect(names).toEqual(["oliver", "oliver-2", "oliver-3"]);
    expect(new Set(names).size).toBe(3);
  });

  test("a rescan cannot forget a pending first-write reservation", async () => {
    const { registry } = await setup();
    await registry.init();
    expect(await registry.ensureDirectory("char_1", "Andrea")).toBe("andrea");
    // A reservation is not a path: resolving its owner remains null until the
    // first profile write materializes the folder, but the reservation survives
    // that rescan and still blocks a peer basename.
    expect(await registry.resolve("char_1")).toBeNull();
    // Resolving any other unknown id is another rescan and must remain harmless.
    expect(await registry.resolve("missing-character")).toBeNull();
    expect(await registry.ensureDirectory("char_2", "Andrea")).toBe("andrea-2");
  });

  test("a failed queued mutation does not poison the next reservation", async () => {
    const { registry } = await setup();
    await registry.init();
    await expect(registry.renameDirectory("missing-character", "unused")).rejects.toThrow(/has no directory/);
    // mutationTail must recover from rejection instead of rejecting all later work.
    expect(await registry.ensureDirectory("char_1", "Andrea")).toBe("andrea");
  });

  test("an existing character is renamed when the display name changes", async () => {
    const { content, registry } = await setup();
    await writeCharDirNamed(content, "oliver", "char_1", "Oliver");
    await registry.init();
    expect(await registry.resolve("char_1")).toBe("oliver");

    const name = await registry.ensureDirectory("char_1", "Oliver Smith");
    expect(name).toBe("oliver-smith");
    expect(await registry.resolve("char_1")).toBe("oliver-smith");
    expect(await content.entityFolderExists(CHARS, "oliver")).toBe(false);
    expect(await content.entityFolderExists(CHARS, "oliver-smith")).toBe(true);
  });

  test("no-op when the derived name matches the current directory", async () => {
    const { content, registry } = await setup();
    await writeCharDirNamed(content, "andrea", "char_1", "Andrea");
    await registry.init();
    const name = await registry.ensureDirectory("char_1", "Andrea");
    expect(name).toBe("andrea");
    expect(await content.entityFolderExists(CHARS, "andrea")).toBe(true);
  });

  test("case-equivalent owner basename is a no-op under portable Windows semantics", async () => {
    const { content, registry } = await setup();
    await writeCharDirNamed(content, "Andrea", "char_1", "Andrea");
    await registry.init();
    expect(await registry.renameForDisplayName("char_1", "ANDREA")).toBe("Andrea");
    expect(await registry.resolve("char_1")).toBe("Andrea");
    expect(await content.entityFolderExists(CHARS, "Andrea")).toBe(true);
  });

  test("a degenerate display name falls back to the opaque character id", async () => {
    const { registry } = await setup();
    await registry.init();
    expect(await registry.ensureDirectory("char_1", "!!!")).toBe("char_1");
  });

  test("long-name collisions preserve the bounded base and add deterministic suffixes", async () => {
    const { registry } = await setup();
    await registry.init();
    const longName = "A".repeat(100);
    expect(await registry.ensureDirectory("char_1", longName)).toBe("a".repeat(60));
    expect(await registry.ensureDirectory("char_2", longName)).toBe(`${"a".repeat(60)}-2`);
  });

  test("Windows-reserved names remain safe under collision suffixing", async () => {
    const { registry } = await setup();
    await registry.init();
    expect(await registry.ensureDirectory("char_1", "CON")).toBe("con-");
    expect(await registry.ensureDirectory("char_2", "con")).toBe("con--2");
  });

  test("the owner's own directory never counts as a collision", async () => {
    const { content, registry } = await setup();
    // char_1 is at "oliver-2" (from a prior collision). Renaming to "Oliver" —
    // "oliver" is taken by char_a, so the owner reclaims its own "oliver-2".
    await writeCharDirNamed(content, "oliver", "char_a", "Oliver");
    await writeCharDirNamed(content, "oliver-2", "char_1", "Steve");
    await registry.init();
    const name = await registry.ensureDirectory("char_1", "Oliver");
    expect(name).toBe("oliver-2"); // own dir, not a collision
  });
});

describe("CharacterDirectoryRegistry.reconcile (HRF-4)", () => {
  test("renames a directory left at a stale name by an interrupted rename", async () => {
    const { content, registry } = await setup();
    // Simulate an interrupted rename: the profile says "Andrea" but the dir is
    // still at a stale non-matching name.
    await writeCharDirNamed(content, "stale-name", "char_1", "Andrea");
    await registry.init();
    expect(await registry.resolve("char_1")).toBe("stale-name");

    const repairs = await registry.reconcile();
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toEqual({ characterId: "char_1", from: "stale-name", to: "andrea" });
    expect(await registry.resolve("char_1")).toBe("andrea");
    expect(await content.entityFolderExists(CHARS, "stale-name")).toBe(false);
  });

  test("skips opaque-id directories (HRF-5 territory)", async () => {
    const { content, registry } = await setup();
    // An opaque-id dir whose profile name is "Andrea" — pre-migration state.
    await writeCharDirNamed(content, "char_1", "char_1", "Andrea");
    await registry.init();
    expect(await registry.reconcile()).toEqual([]);
    expect(await registry.resolve("char_1")).toBe("char_1"); // unchanged
    expect(await content.entityFolderExists(CHARS, "char_1")).toBe(true);
  });

  test("is a no-op on a consistent tree", async () => {
    const { content, registry } = await setup();
    await writeCharDirNamed(content, "andrea", "char_1", "Andrea");
    await registry.init();
    expect(await registry.reconcile()).toEqual([]);
  });

  test("does not thrash a case-equivalent basename on case-insensitive filesystems", async () => {
    const { content, registry } = await setup();
    await writeCharDirNamed(content, "Andrea", "char_1", "Andrea");
    await registry.init();
    expect(await registry.reconcile()).toEqual([]);
    expect(await registry.resolve("char_1")).toBe("Andrea");
  });

  test("treats a collision-suffixed directory as consistent", async () => {
    const { content, registry } = await setup();
    await writeCharDirNamed(content, "oliver", "char_1", "Oliver");
    await writeCharDirNamed(content, "oliver-2", "char_2", "Oliver");
    await registry.init();
    expect(await registry.reconcile()).toEqual([]);
    expect(await registry.resolve("char_1")).toBe("oliver");
    expect(await registry.resolve("char_2")).toBe("oliver-2");
  });

  test("two interrupted characters with the same name resolve to distinct suffixes", async () => {
    const { content, registry } = await setup();
    await writeCharDirNamed(content, "stale-a", "char_1", "Oliver");
    await writeCharDirNamed(content, "stale-b", "char_2", "Oliver");
    await registry.init();
    const repairs = await registry.reconcile();
    expect(repairs).toEqual([
      { characterId: "char_1", from: "stale-a", to: "oliver" },
      { characterId: "char_2", from: "stale-b", to: "oliver-2" },
    ]);
    expect(await registry.resolve("char_1")).toBe("oliver");
    expect(await registry.resolve("char_2")).toBe("oliver-2");
  });

  test("a failed repair reports diagnostics, preserves the stale mapping, and does not poison later work", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "vt-reg-reconcile-failure-"));
    const realFileStore = createFileStore(dataRoot);
    const failingFileStore: FileStore = {
      ...realFileStore,
      rename: async () => {
        throw new Error("injected reconcile rename failure");
      },
    };
    const content = new ContentStore({ fileStore: failingFileStore });
    await writeCharDirNamed(content, "stale-name", "char_1", "Andrea");
    const registry = new CharacterDirectoryRegistry(content);
    await registry.init();

    expect(await registry.reconcile()).toEqual([{
      characterId: "char_1",
      from: "stale-name",
      to: "andrea",
      failed: true,
      error: "injected reconcile rename failure",
    }]);
    expect(await registry.resolve("char_1")).toBe("stale-name");
    expect(await content.entityFolderExists(CHARS, "stale-name")).toBe(true);
    expect(await content.entityFolderExists(CHARS, "andrea")).toBe(false);
    // renameDirectory's rejected queue entry was normalized; later mutations run.
    expect(await registry.ensureDirectory("char_2", "Bea")).toBe("bea");
  });
});
