import { describe, expect, test } from "bun:test";
import type { CoauthorEditorState } from "@vibe-tavern/api-contracts";
import { parseProfileMd } from "@vibe-tavern/db";
import {
  buildCoauthorWorkingDocument,
  mapCoauthorProfileToCharacterFields,
} from "../src/domain/chat/coauthor-working-document.js";

const savedProfileMd = [
  "---",
  "name: Saved Name",
  "tags: [saved]",
  "creator: Server Creator",
  "character_version: v7",
  "vt:",
  "  storage_id: char_storage",
  "  mes_example_mode: depth",
  "  mes_example_depth: 6",
  "  server_flag: keep",
  "custom_key: custom-value",
  "---",
  "",
  "# PERSONALITY",
  "Saved personality.",
  "",
  "# SCENARIO",
  "Saved scenario.",
  "",
  "# EXAMPLES",
  "Saved example.",
  "",
  "# CUSTOM",
  "Saved custom section.",
].join("\n");

function editorState(overrides?: Partial<CoauthorEditorState["card"]>): CoauthorEditorState {
  return {
    card: {
      name: "Live Name",
      body: "# PERSONALITY\nLive personality.\n\n# SCENARIO\nLive scenario.\n\n# EXAMPLES\nLive example.\n\n# GREETINGS\nIgnored synthetic view.",
      greetings: ["Live primary.", "Live alternate."],
      cardClean: false,
      ...overrides,
    },
    review: { targets: [] },
  };
}

describe("coauthor working document", () => {
  test("overlays live editable fields while preserving canonical server metadata", () => {
    const state = editorState();
    const result = buildCoauthorWorkingDocument(savedProfileMd, state);
    const parsed = parseProfileMd(result.profileMd);

    expect(parsed.profile.name).toBe("Live Name");
    expect(parsed.profile.description).toBe("Live personality.");
    expect(parsed.profile.scenario).toBe("Live scenario.");
    expect(parsed.profile.mesExample).toBe("Live example.");
    expect(parsed.profile.creator).toBe("Server Creator");
    expect(parsed.profile.characterVersion).toBe("v7");
    expect(parsed.storageId).toBe("char_storage");
    expect(parsed.unknownVt).toEqual([{ key: "server_flag", value: "keep", block: false }]);
    expect(parsed.unknownFrontmatter).toEqual([{ key: "custom_key", value: "custom-value", block: false }]);
    expect(parsed.unknownSections).toEqual([{ heading: "CUSTOM", body: "Saved custom section." }]);
    expect(result.profileMd).not.toContain("# GREETINGS");
    expect(result.character).toEqual({ firstMessage: "Live primary.", alternateGreetings: ["Live alternate."] });
  });

  test("keeps explicit empty editor fields empty without mutating either input", () => {
    const state = editorState({ name: "", body: "", greetings: [] });
    const originalState = structuredClone(state);
    const result = buildCoauthorWorkingDocument(savedProfileMd, state);
    const parsed = parseProfileMd(result.profileMd);

    expect(parsed.profile.name).toBe("");
    expect(parsed.profile.description).toBe("");
    expect(parsed.profile.scenario).toBeNull();
    expect(parsed.profile.mesExample).toBeNull();
    expect(result.character).toEqual({ firstMessage: "", alternateGreetings: [] });
    expect(state).toEqual(originalState);
    expect(savedProfileMd).toContain("Saved personality.");
  });

  test("maps canonical profile fields without dropping unrelated extension metadata", () => {
    const profile = parseProfileMd(savedProfileMd).profile;
    const fields = mapCoauthorProfileToCharacterFields(profile, { server_only: "keep", creator: "old" });

    expect(fields.extensions).toEqual({ server_only: "keep", creator: "Server Creator", character_version: "v7" });
    expect(fields).toMatchObject({ description: "Saved personality.", scenario: "Saved scenario.", mesExample: "Saved example." });
  });
});
