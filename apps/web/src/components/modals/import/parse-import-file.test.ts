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
import { test, expect, describe } from "vitest";
import { packMonolith, type VtfCharacterContent } from "@vibe-tavern/db/codecs";
import { parseCharacterFile, readCardRaw } from "./parse-import-file.js";

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

// ─── readCardRaw (shared by every character-import entry point) ────────────

describe("readCardRaw", () => {
  test("returns a V3-card-shaped object for a .md monolith (data block with V3 field names)", async () => {
    const md = packMonolith(fullContent());
    const file = new File([md], "s.md", { type: "text/markdown" });
    const raw = (await readCardRaw(file)) as { spec: string; data: Record<string, unknown> };
    // Card-shape — what parseCardToDraft (Build merge-import) reads.
    expect(raw.spec).toBe("chara_card_v3");
    expect(raw.data.name).toBe("Silvius");
    expect(raw.data.first_mes).toBe("The door creaks.");
    expect(raw.data.scenario).toBe("A tavern.");
    expect(raw.data.personality).toBe("calm");
    expect(raw.data.depth_prompt).toBeNull();
    expect(raw.data.tags).toEqual(["modern", "werewolf"]);
  });

  test("accepts .markdown and .vtmd", async () => {
    const md = packMonolith(fullContent());
    for (const ext of [".markdown", ".vtmd"]) {
      const raw = (await readCardRaw(new File([md], `c${ext}`))) as { data: Record<string, unknown> };
      expect(raw.data.name).toBe("Silvius");
    }
  });

  test("passes a JSON card through untouched (JSON branch)", async () => {
    const card = { spec: "chara_card_v3", data: { name: "X" } };
    const file = new File([JSON.stringify(card)], "c.json", { type: "application/json" });
    expect(await readCardRaw(file)).toEqual(card);
  });

  test("the card-shape output round-trips through a parseCardToDraft-style reader", async () => {
    // Mirrors CharacterForm.parseCardToDraft: prove the reshape feeds the
    // Build-editor merge-import without field-name loss.
    const md = packMonolith(fullContent({ depthPrompt: "Remember the scar.", systemPrompt: "2nd person." }));
    const raw = (await readCardRaw(new File([md], "s.md"))) as { data: Record<string, unknown> };
    const d = raw.data;
    const picked: Record<string, unknown> = {};
    if (d.name) picked.name = String(d.name);
    if (d.first_mes) picked.firstMessage = String(d.first_mes);
    if (d.depth_prompt) picked.depthPrompt = String(d.depth_prompt);
    if (d.system_prompt) picked.systemPrompt = String(d.system_prompt);
    expect(picked).toEqual({
      name: "Silvius",
      firstMessage: "The door creaks.",
      depthPrompt: "Remember the scar.",
      systemPrompt: "2nd person.",
    });
  });
});
