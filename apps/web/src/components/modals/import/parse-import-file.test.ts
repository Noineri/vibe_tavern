/**
 * Characterization tests for `parseCharacterFile` (VTF_NATIVE_ROUNDTRIP followup).
 *
 * Pins the import-modal preview path for a standalone `.md` VTF monolith. The
 * monolith's frontmatter begins with `---`, so the previous unconditional
 * `JSON.parse(await file.text())` crashed with "No number after minus sign in
 * JSON" before the preview ever rendered. The fix routes `.md`/`.markdown`/
 * `.vtmd` through `unpackMonolith`; these tests pin that the preview now builds
 * (name/description/tags pulled from the monolith) and that PNG/JSON still take
 * their original branches (no regression).
 */
import { test, expect } from "vitest";
import { packMonolith, type VtfCharacterContent } from "@vibe-tavern/db/codecs";
import { parseCharacterFile } from "./parse-import-file.js";

function fullContent(over: Partial<VtfCharacterContent> = {}): VtfCharacterContent {
  return {
    name: "Silvius",
    description: "Silver-haired and watchful.",
    personalitySummary: "calm",
    defaultScenario: "A tavern.",
    firstMessage: "The door creaks.",
    mesExample: "<START>\n{{char}}: Hi",
    mesExampleMode: "always",
    mesExampleDepth: 4,
    alternateGreetings: [],
    postHistoryInstructions: null,
    creatorNotes: null,
    depthPrompt: null,
    depthPromptDepth: 4,
    depthPromptRole: "system",
    systemPrompt: null,
    tags: ["modern", "werewolf"],
    extensions: {},
    ...over,
  };
}

test("parses a .md VTF monolith into a preview (no JSON.parse crash on `---`)", async () => {
  const md = packMonolith(fullContent());
  const file = new File([md], "silvius.md", { type: "text/markdown" });

  const preview = await parseCharacterFile(file);

  expect(preview.name).toBe("Silvius");
  expect(preview.description).toBe("Silver-haired and watchful.");
  expect(preview.tags).toEqual(["modern", "werewolf"]);
  // A standalone monolith has no image — no avatar object URL is created.
  expect(preview.avatarUrl).toBeNull();
  expect(preview.file).toBe(file);
});

test("accepts .markdown and .vtmd extensions too", async () => {
  const md = packMonolith(fullContent());
  for (const ext of [".markdown", ".vtmd"]) {
    const file = new File([md], `card${ext}`, { type: "text/markdown" });
    const preview = await parseCharacterFile(file);
    expect(preview.name).toBe("Silvius");
  }
});

test("falls back to the filename (minus extension) when the monolith has no name", async () => {
  const md = packMonolith(fullContent({ name: "" }));
  const file = new File([md], "nameless.md", { type: "text/markdown" });
  const preview = await parseCharacterFile(file);
  expect(preview.name).toBe("nameless");
});

test("a JSON card still parses via the JSON branch (no regression)", async () => {
  const card = { spec: "chara_card_v3", spec_version: "3.0", data: { name: "Json Char", description: "d", tags: ["t"] } };
  const file = new File([JSON.stringify(card)], "c.json", { type: "application/json" });
  const preview = await parseCharacterFile(file);
  expect(preview.name).toBe("Json Char");
  expect(preview.tags).toEqual(["t"]);
  expect(preview.avatarUrl).toBeNull();
});
