/**
 * Characterization tests for `appCharacterToVtfContent` (VTF_NATIVE_ROUNDTRIP Wave 3).
 *
 * Pins the export-side projection that feeds BOTH the PNG `vtmd` chunk and the
 * standalone VTF `.md` export. The load-bearing behavior is the `character_book`
 * INJECTION: the ST V3 export keeps the lorebook at `data.character_book`, while
 * the VTF monolith codec keeps it inside the `extensions` fence — so the
 * projection must lift it into `extensions.character_book` for the monolith to
 * carry it losslessly (the import adapter promotes it back out on return).
 * Round-trips with `packMonolith`/`unpackMonolith` confirm the injected book
 * survives the codec (the codec's own character_book round-trip is pinned in
 * packages/db; this test pins the projection that feeds it).
 */
import { test, expect } from "bun:test";
import { packMonolith, unpackMonolith } from "@vibe-tavern/db/codecs";
import type { AppCharacter } from "../app-client.js";
import { appCharacterToVtfContent } from "./vtf-content.js";

/** Minimal AppCharacter with the fields the projection reads. */
function makeChar(over: Partial<AppCharacter> = {}): AppCharacter {
  return {
    id: "char_1",
    name: "Silvius",
    description: "Silver-haired and watchful.",
    personalitySummary: "calm",
    scenario: "A tavern at the forest's edge.",
    firstMessage: "The door creaks open.",
    mesExample: "<START>\n{{char}}: Welcome.",
    mesExampleMode: "depth",
    mesExampleDepth: 4,
    alternateGreetings: ["A second opener."],
    postHistoryInstructions: "Keep it brief.",
    creatorNotes: "Internal notes.",
    depthPrompt: "Remember the silver scar.",
    depthPromptDepth: 4,
    depthPromptRole: "system",
    systemPrompt: "Respond in second person.",
    tags: ["modern", "werewolf"],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  } as unknown as AppCharacter;
}

test("projects every AppCharacter field onto VtfCharacterContent", () => {
  const content = appCharacterToVtfContent(makeChar(), { data: { extensions: { talkativeness: "0.5" } } });
  expect(content.name).toBe("Silvius");
  expect(content.personalitySummary).toBe("calm");
  expect(content.defaultScenario).toBe("A tavern at the forest's edge.");
  expect(content.mesExampleMode).toBe("depth");
  expect(content.mesExampleDepth).toBe(4);
  expect(content.depthPrompt).toBe("Remember the silver scar.");
  expect(content.systemPrompt).toBe("Respond in second person.");
  expect(content.extensions).toEqual({ talkativeness: "0.5" });
});

test("injects data.character_book into the extensions fence (lossless lorebook)", () => {
  const book = { entries: [{ keys: ["scar"], content: "a silver scar" }] };
  const content = appCharacterToVtfContent(makeChar(), {
    data: { extensions: { talkativeness: "0.5" }, character_book: book },
  });
  expect(content.extensions.character_book).toEqual(book);
  // Existing extension keys are preserved alongside it.
  expect(content.extensions.talkativeness).toBe("0.5");
});

test("does not inject a missing or non-object character_book", () => {
  const a = appCharacterToVtfContent(makeChar(), { data: { extensions: {} } });
  expect("character_book" in a.extensions).toBe(false);
  const b = appCharacterToVtfContent(makeChar(), { data: { extensions: {}, character_book: "nope" } });
  expect("character_book" in b.extensions).toBe(false);
});

test("does not mutate the caller's export data.extensions", () => {
  const exportData = { data: { extensions: { talkativeness: "0.5" }, character_book: { entries: [] } } };
  appCharacterToVtfContent(makeChar(), exportData);
  // The original extensions object is untouched (no character_book added in place).
  expect("character_book" in exportData.data.extensions).toBe(false);
  expect(exportData.data.extensions.talkativeness).toBe("0.5");
});

test("tolerates a missing extensions block (yields {} rather than throwing)", () => {
  const content = appCharacterToVtfContent(makeChar(), { data: {} });
  expect(content.extensions).toEqual({});
});

test("injected character_book survives a packMonolith → unpackMonolith round-trip", () => {
  const book = { entries: [{ keys: ["forest"], content: "The forest is dark." }] };
  const content = appCharacterToVtfContent(makeChar(), { data: { character_book: book } });
  const back = unpackMonolith(packMonolith(content));
  expect(back.extensions.character_book).toEqual(book);
  // And the prose fields survived too.
  expect(back.name).toBe("Silvius");
  expect(back.depthPrompt).toBe("Remember the silver scar.");
});
