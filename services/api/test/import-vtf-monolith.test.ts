/**
 * Characterization test for the native VTF monolith import path
 * (VTF_NATIVE_ROUNDTRIP_PLAN Wave 1, unit VTF-3).
 *
 * Pins the contract that `importJson({ monolithText })` — the path taken when a
 * PNG `vtmd` chunk or a standalone `.md` monolith is supplied — builds the
 * character from the LOSSLESS native representation rather than the lossy ST
 * `chara`/`ccv3` JSON:
 *
 *   1. The store `create` receives the VTF-native fields verbatim, including
 *      the ones ST JSON drops or hardcodes: depth-prompt config, mesExampleMode
 *      "depth", personalitySummary, and a nested `character_book` PROMOTED out
 *      of the extensions fence into the dedicated `characterBook` field.
 *   2. NO `original.json` is written (the field set is already lossless; a
 *      non-JSON original would break `exportCharacter`'s merge) — `writeEntity`
 *      is never called for an `.../original` key.
 *   3. The seeded opening mirrors the monolith's greeting set.
 *
 * The monolith is produced by the REAL `packMonolith` codec, so this exercises
 * the full `packMonolith → unpackMonolith → vtfContentToImportedBundle →
 * importJson tail` chain end-to-end (per AGENTS.md §1, a boundary-level
 * characterization test — the exact boundary where a regression would silently
 * drop VTF-native fields).
 */
import { test, expect, mock, describe } from "bun:test";
import { packMonolith, type VtfCharacterContent } from "@vibe-tavern/db";
import type { ImportExportModuleDeps } from "../src/runtime/session/session-runtime-import-export.js";
import { importJson } from "../src/runtime/session/session-runtime-import-export.js";

/** A VTF-native character carrying fields ST JSON cannot losslessly represent. */
const VTF_CONTENT: VtfCharacterContent = {
  name: "Silvius",
  description: "Silver-haired and watchful.",
  personalitySummary: "calm", // ST JSON drops this for VTF-native cards
  defaultScenario: "A tavern at the forest's edge.",
  firstMessage: "The door creaks open.",
  mesExample: "<START>\n{{char}}: Welcome.",
  mesExampleMode: "depth", // ST JSON hardcodes "always"
  mesExampleDepth: 4,
  alternateGreetings: ["A second opener."],
  postHistoryInstructions: "Keep it brief.",
  creatorNotes: "Internal notes.",
  depthPrompt: "Remember the silver scar.",
  depthPromptDepth: 4, // ST JSON has no depth config
  depthPromptRole: "system",
  systemPrompt: "Respond in second person.",
  tags: ["modern", "werewolf"],
  extensions: {
    creator: "anonymous",
    character_version: "1.0",
    // A nested lorebook rides in the extensions fence — must be PROMOTED to
    // characterBook on import so the lorebook engine picks it up.
    character_book: { entries: [{ keys: ["scar"], content: "a silver scar" }] },
  },
};

/** Builds a stub deps whose `create` mock captures its input for assertions. */
function makeDeps() {
  let createInput: unknown = null;
  const writeEntityPaths: string[] = [];
  let seedFirst: string | undefined;
  let seedAlts: string[] | undefined;

  const deps = {
    stores: {
      characters: {
        getById: mock((_id: string) => Promise.resolve(null)),
        create: mock((data: unknown) => {
          createInput = data;
          return Promise.resolve({ id: "char_vtf_001" }) as never;
        }),
        update: mock((_id: string, _patch: unknown) => Promise.resolve() as never),
        resolveFolderName: mock((id: string) => Promise.resolve(id)),
      },
      content: {
        writeEntity: mock((_folder: unknown, id: string, _data: unknown) => {
          writeEntityPaths.push(id);
          return Promise.resolve("stub/path") as never;
        }),
      },
    },
    chatApp: {
      createChat: mock((_input: unknown) =>
        Promise.resolve({ id: "chat_vtf_002", activeBranchId: "br_vtf_003" }) as never,
      ),
    },
    chatOrder: { add: mock((_id: unknown) => {}) },
    resolveDefaultPersonaId: mock(() => Promise.resolve("persona_default" as never)),
    resolveDefaultPromptPresetId: mock(() => Promise.resolve("preset_default" as never)),
    seedImportedOpening: mock((_chatId: unknown, first: string, alts?: string[]) => {
      seedFirst = first;
      seedAlts = alts;
      return Promise.resolve() as never;
    }),
    getSnapshot: mock((_chatId: unknown) =>
      Promise.resolve({ chats: [], messages: [] }) as never,
    ),
    resolver: {
      getCharacter: () => { throw new Error("not used"); },
      getPersona: () => { throw new Error("not used"); },
    },
    fileStore: { resolvePath: () => { throw new Error("not used"); } },
  } as unknown as ImportExportModuleDeps;
  return { deps, getCreateInput: () => createInput, getWritePaths: () => writeEntityPaths, getSeed: () => ({ first: seedFirst, alts: seedAlts }) };
}

describe("importJson — native VTF monolith path (VTF_NATIVE_ROUNDTRIP Wave 1)", () => {
  const monolith = packMonolith(VTF_CONTENT);

  test("creates the character from the lossless monolith with every native field", async () => {
    const { deps, getCreateInput, getWritePaths, getSeed } = makeDeps();

    const result = await importJson(deps, {
      fileName: "silvius.md",
      monolithText: monolith,
    });

    const created = getCreateInput() as Record<string, unknown>;
    expect(created).not.toBeNull();
    // Fields ST JSON drops / hardcodes are preserved from the monolith.
    expect(created.name).toBe("Silvius");
    expect(created.personalitySummary).toBe("calm");
    expect(created.mesExampleMode).toBe("depth");
    expect(created.mesExampleDepth).toBe(4);
    expect(created.depthPrompt).toBe("Remember the silver scar.");
    expect(created.depthPromptDepth).toBe(4);
    expect(created.depthPromptRole).toBe("system");
    expect(created.systemPrompt).toBe("Respond in second person.");
    // The nested character_book is PROMOTED to the dedicated field...
    expect(created.characterBook).toEqual({ entries: [{ keys: ["scar"], content: "a silver scar" }] });
    // ...and STRIPPED from extensions.
    const ext = created.extensions as Record<string, unknown>;
    expect("character_book" in ext).toBe(false);

    // No original.json is written on the monolith path.
    expect(getWritePaths().every((p) => !p.includes("/original"))).toBe(true);

    // The seeded opening mirrors the monolith's greeting set.
    const seed = getSeed();
    expect(seed.first).toBe("The door creaks open.");
    expect(seed.alts).toEqual(["A second opener."]);

    // Result shape.
    expect(result.characterId).toBe("char_vtf_001");
    expect(result.activeChatId).toBe("chat_vtf_002");
    expect(result.imported.kind).toBe("character");
    expect(result.imported.name).toBe("Silvius");
    expect(result.imported.fileName).toBe("silvius.md");
  });

  test("prefers the monolith over jsonText when both are supplied (vtmd-wins)", async () => {
    // A PNG carrying BOTH a vtmd chunk and a lossy chara/ccv3 JSON sends both;
    // the backend must use the monolith. We detect this by giving the JSON a
    // DIFFERENT name — if the JSON won, the created name would be the JSON's.
    const { deps, getCreateInput } = makeDeps();
    const lossyJson = JSON.stringify({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: { name: "WRONG-FROM-JSON", description: "stub" },
    });

    await importJson(deps, {
      fileName: "silvius.png",
      jsonText: lossyJson,
      monolithText: monolith,
    });

    const created = getCreateInput() as Record<string, unknown>;
    expect(created.name).toBe("Silvius"); // monolith won, not "WRONG-FROM-JSON"
  });

  test("deterministic id: re-importing the same monolith resolves to the same character id", async () => {
    const { deps: depsA } = makeDeps();
    const rA = await importJson(depsA, { fileName: "a.md", monolithText: monolith });
    const { deps: depsB } = makeDeps();
    const rB = await importJson(depsB, { fileName: "b.md", monolithText: monolith });
    expect(rA.characterId).toBe(rB.characterId);
  });

  test("rejects an empty monolith payload", async () => {
    const { deps } = makeDeps();
    await expect(
      importJson(deps, { fileName: "empty.md", monolithText: "   " }),
    ).rejects.toThrow("empty");
  });
});
