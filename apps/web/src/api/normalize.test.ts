import { describe, expect, test } from "bun:test";
import { normalizeSnapshot } from "./normalize.js";
import type { AppCharacter, AppMessage, AppSnapshot } from "./types.js";

/**
 * Phase 3.4.1 — normalizeSnapshot must PRESERVE field absence.
 *
 * The old implementation coerced every absent array to `[]` and every absent
 * scalar to `null`/`{}`, which silently converted "server omitted this field"
 * into "server wiped this field" and made ingestSnapshot's presence guards
 * dead code (the TD-004 root cause). Absent keys must stay absent.
 */

function makeCharacter(): AppCharacter {
  return {
    id: "c1",
    name: "Char",
    avatarExt: null,
    avatarFullExt: null,
    description: "",
    scenario: "",
    systemPrompt: "",
    subtitle: "",
    firstMessage: "hi",
    mesExample: null,
    mesExampleMode: "always",
    mesExampleDepth: 4,
    alternateGreetings: [],
    postHistoryInstructions: null,
    creatorNotes: null,
    depthPrompt: null,
    depthPromptDepth: null,
    depthPromptRole: null,
    tags: [],
    avatarAssetId: null,
    avatarFullAssetId: null,
    avatarCropJson: null,
    personalitySummary: null,
    includeGalleryInPrompt: false,
    includeAvatarInPrompt: false,
    avatarDescription: null,
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

describe("normalizeSnapshot — absence preservation (Phase 3.4.1)", () => {
  test("absent fields are NOT added to the output object", () => {
    const partial = {
      character: makeCharacter(),
      contextPreview: null,
    } as AppSnapshot;

    const out = normalizeSnapshot(partial);

    // present fields survive
    expect(out.character?.id).toBe("c1");
    expect(out.contextPreview).toBeNull();

    // absent fields stay ABSENT (the fix) — not coerced to [] / null
    expect("messages" in out).toBe(false);
    expect("chats" in out).toBe(false);
    expect("branches" in out).toBe(false);
    expect("summaries" in out).toBe(false);
    expect("allCharacters" in out).toBe(false);
    expect("promptTraceHistory" in out).toBe(false);
    expect("persona" in out).toBe(false);
    expect("activeChat" in out).toBe(false);
    expect("activeBranch" in out).toBe(false);
    expect("promptTrace" in out).toBe(false);

    // and reading them yields undefined (not [])
    expect(out.messages).toBeUndefined();
    expect(out.chats).toBeUndefined();
  });

  test("present character survives intact (idempotent on a well-formed character)", () => {
    const out = normalizeSnapshot({ character: makeCharacter() } as AppSnapshot);
    expect(out.character).toEqual(makeCharacter());
  });

  test("present messages are passed through normalizeMessage", () => {
    const messages = [
      { id: "m1", role: "assistant", content: "hi", variants: [], selectedVariantIndex: null },
    ] as unknown as AppMessage[];
    const out = normalizeSnapshot({ messages } as AppSnapshot);
    expect(out.messages).toHaveLength(1);
    expect(out.messages?.[0].variants).toEqual([]);
    expect(out.messages?.[0].selectedVariantIndex).toBeNull();
  });

  test("absent character means no character block is synthesised", () => {
    const out = normalizeSnapshot({ messages: [] } as AppSnapshot);
    expect("character" in out).toBe(false);
    expect(out.character).toBeUndefined();
  });
});
