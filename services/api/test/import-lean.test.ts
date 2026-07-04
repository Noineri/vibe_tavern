/**
 * Characterization test for the `lean` flag on `importJson` (Wave 1, MASS_IMPORT).
 *
 * The mass-import bottleneck (see reports/mass-import-bottleneck.md, bench #3)
 * is the O(N²) `getSnapshot` rebuild: every importJson returned
 * `await deps.getSnapshot(chatId)`, and getSnapshot rebuilds the chat list over
 * ALL chatOrder.items — which grows by 1 per import. Across 1300 cards that is
 * ~845,000 chat reads, and the frontend ignores the returned snapshot entirely.
 *
 * Wave 1 threads a `lean` flag: when true, the backend skips getSnapshot and
 * returns `{ activeChatId, characterId, imported }` (no snapshot). This test
 * pins the two halves of that contract so a future regression that drops the
 * flag — or calls getSnapshot unconditionally — fails loudly:
 *
 *   1. `lean: true`  → getSnapshot is NEVER called; snapshot is undefined;
 *      characterId is present (so the avatar upload can resolve without snapshot).
 *   2. no lean flag → getSnapshot is called exactly once; snapshot is present
 *      (single-card import path stays byte-identical).
 *
 * Uses a minimal V2 card fixture (real `importCharacterCardV3Json` runs) and a
 * stub `ImportExportModuleDeps` that records getSnapshot calls. Per AGENTS.md §1
 * this characterization test was written before any further refactor of the
 * import path, so the pinned behavior is the current (post-Wave-1) contract.
 */
import { test, expect, mock, describe } from "bun:test";
import type { ImportExportModuleDeps } from "../src/runtime/session/session-runtime-import-export.js";
import { importJson } from "../src/runtime/session/session-runtime-import-export.js";

// Minimal V2 card — real importCharacterCardV3Json parses it and synthesizes
// a deterministic character id from the name, so `getById` returns null below
// (new-character create path, the one the mass-import hot path takes).
const V2_CARD = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: { name: "Lean Test Char", description: "stub" },
};

/** Builds a fresh stub deps with a call-counting getSnapshot mock. */
function makeDeps() {
  const getSnapshot = mock((_chatId: unknown) =>
    Promise.resolve({ chats: [], messages: [] }) as never,
  );
  const deps = {
    stores: {
      characters: {
        getById: mock((_id: string) => Promise.resolve(null)),
        create: mock((_data: unknown) =>
          Promise.resolve({ id: "char_test_123" }) as never,
        ),
        update: mock((_id: string, _patch: unknown) => Promise.resolve() as never),
      },
      content: {
        writeEntity: mock((_folder: unknown, _id: string, _data: unknown) =>
          Promise.resolve("stub/path") as never,
        ),
      },
    },
    chatApp: {
      createChat: mock((_input: unknown) =>
        Promise.resolve({ id: "chat_test_456", activeBranchId: "br_test_789" }) as never,
      ),
    },
    chatOrder: {
      add: mock((_id: unknown) => {}),
    },
    resolveDefaultPersonaId: mock(() => Promise.resolve("persona_default" as never)),
    resolveDefaultPromptPresetId: mock(() => Promise.resolve("preset_default" as never)),
    seedImportedOpening: mock((_chatId: unknown, _first: string, _alts?: string[]) =>
      Promise.resolve() as never,
    ),
    getSnapshot,
    // Export-only deps — not exercised by importJson; left as throwing stubs so
    // any accidental use surfaces immediately rather than returning undefined.
    resolver: {
      getCharacter: () => { throw new Error("resolver.getCharacter should not be called by importJson"); },
      getPersona: () => { throw new Error("resolver.getPersona should not be called by importJson"); },
    },
    fileStore: {
      resolvePath: () => { throw new Error("fileStore should not be called by importJson"); },
    },
  } as unknown as ImportExportModuleDeps;
  return { deps, getSnapshot };
}

describe("importJson — lean mass-import path (MASS_IMPORT Wave 1)", () => {
  test("lean: true skips getSnapshot entirely and returns characterId without snapshot", async () => {
    const { deps, getSnapshot } = makeDeps();

    const result = await importJson(deps, {
      fileName: "card.png",
      jsonText: JSON.stringify(V2_CARD),
      skipExisting: true,
      lean: true,
    });

    // The killer call is gone — this is the whole point of Wave 1.
    expect(getSnapshot).toHaveBeenCalledTimes(0);

    // Lean shape: no snapshot, but characterId resolves the avatar upload.
    expect(result.snapshot).toBeUndefined();
    expect(result.characterId).toBe("char_test_123");
    expect(result.activeChatId).toBe("chat_test_456");
    expect(result.imported.kind).toBe("character");
    expect(result.imported.name).toBe("Lean Test Char");
    expect(result.imported.fileName).toBe("card.png");
  });

  test("no lean flag keeps the full path byte-identical: getSnapshot called once, snapshot present", async () => {
    const { deps, getSnapshot } = makeDeps();

    const result = await importJson(deps, {
      fileName: "card.json",
      jsonText: JSON.stringify(V2_CARD),
      // single-card import: no lean flag
    });

    // Single-card path still pays for the snapshot (and the frontend uses it).
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(getSnapshot.mock.calls[0][0]).toBe("chat_test_456");

    // characterId is also present on the full path (benign; lets the frontend
    // read one field regardless of mode), but the snapshot is the load-bearing
    // field for single-card import.
    expect(result.characterId).toBe("char_test_123");
    expect(result.snapshot).toBeDefined();
    expect(result.activeChatId).toBe("chat_test_456");
  });
});
