import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { ChatModeAssembleInput, ChatModeAssembleLoaders } from "../src/domain/chat/chat-mode-strategy.js";
import { assembleCoauthorPrompt } from "../src/domain/chat/coauthor-prompt.js";
import type { ActiveLoreEntry } from "@vibe-tavern/domain";
import type { Character, Message as DbMessage } from "@vibe-tavern/db";

/**
 * Co-Author assembly characterization. Pins what the model + frontend can
 * rely on each turn: the editor prompt is assembled from base + skill +
 * current-card context, conversation history is forwarded, and the tool set
 * + maxSteps ride out for the executor. Pure (loaders mocked; real asset
 * files under services/api/assets/coauthor/ are read).
 */

function makeLoaders(overrides?: Partial<{
  character: Partial<Character>;
  profileMd: string;
  messages: DbMessage[];
  loreEntries: ActiveLoreEntry[];
}>): ChatModeAssembleLoaders {
  const character: Character = {
    id: "char_test",
    slug: "test",
    name: "Test",
    description: "desc",
    personalitySummary: null,
    defaultScenario: null,
    firstMessage: "The opener.",
    mesExample: null,
    mesExampleMode: "depth",
    mesExampleDepth: 4,
    alternateGreetings: ["An alt opener."],
    postHistoryInstructions: null,
    creatorNotes: null,
    characterBook: null,
    depthPrompt: null,
    depthPromptDepth: null,
    depthPromptRole: null,
    extensions: {},
    systemPrompt: null,
    tags: [],
    avatarAssetId: null,
    avatarFullAssetId: null,
    avatarCrop: null,
    avatarExt: null,
    hasFileOnDisk: true,
    ...overrides?.character,
  } as unknown as Character;

  return {
    getMessages: async () => overrides?.messages ?? [],
    getCharacter: async () => character,
    getProfileMdText: async () => overrides?.profileMd ?? "---\nname: Test\n---\n# PERSONALITY\nA test character.\n",
    getActiveLoreEntries: async () => overrides?.loreEntries ?? [],
  };
}

function makeInput(loaders: ChatModeAssembleLoaders, partial?: Partial<ChatModeAssembleInput>): ChatModeAssembleInput {
  return {
    promptService: {} as never,
    chatId: "chat_test" as never,
    model: "test-model",
    loaders,
    ...partial,
  } as ChatModeAssembleInput;
}

describe("assembleCoauthorPrompt", () => {
  test("assembles system + history + tools/maxSteps", async () => {
    const loaders = makeLoaders({
      messages: [
        { role: "user", content: "make the personality deeper" } as never,
        { role: "assistant", content: "on it" } as never,
        { role: "system", content: "filtered out" } as never,
      ],
    });
    const result = await assembleCoauthorPrompt(makeInput(loaders));

    // Tools + maxSteps ride out for the executor (CA-5 wiring).
    expect(result.tools).toBeDefined();
    expect(result.maxSteps).toBe(5);
    expect(result.tools).toHaveProperty("edit_profile");
    expect(result.tools).toHaveProperty("edit_greeting");
    expect(result.tools).toHaveProperty("add_alt_greeting");

    // Final payload: one system message + the user/assistant history (system rows filtered).
    const messages = (result.prompt.finalPayload as { messages: Array<{ role: string; content: string }> }).messages;
    expect(messages[0].role).toBe("system");
    expect(messages.length).toBe(3); // system + user + assistant
    expect(messages[1]).toEqual({ role: "user", content: "make the personality deeper" });
    expect(messages[2]).toEqual({ role: "assistant", content: "on it" });
  });

  test("system message embeds the base prompt, current card, and profile.md", async () => {
    const loaders = makeLoaders({
      profileMd: "---\nname: Test\n---\n# PERSONALITY\nA test character.\n",
      character: { firstMessage: "PRIMARY OPENER", alternateGreetings: ["ALT ONE"] },
    });
    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;

    // Base editor prompt marker.
    expect(system).toContain("Co-Author");
    // Current profile.md is embedded read-only.
    expect(system).toContain("# PERSONALITY");
    expect(system).toContain("A test character.");
    // Greetings rendered with their slot labels.
    expect(system).toContain("PRIMARY OPENER");
    expect(system).toContain("ALT ONE");
    expect(system).toContain("PRIMARY (firstMessage)");
    expect(system).toContain("ALT 1");
  });

  test("autodetects personality-deepen skill from the latest user message", async () => {
    const loaders = makeLoaders({
      messages: [{ role: "user", content: "this personality is too flat and generic" } as never],
    });
    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;
    // Skill overlay text from personality-deepen.md is injected under "# Active skill".
    expect(system).toContain("# Active skill");
    expect(system).toContain("Personality Deepen");
  });

  test("falls back to profile-overview skill when no keyword matches", async () => {
    const loaders = makeLoaders({
      messages: [{ role: "user", content: "hello" } as never],
    });
    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;
    expect(system).toContain("Profile Overview");
  });

  test("promptTraceDraft carries coauthor preset name and empty RP layers", async () => {
    const loaders = makeLoaders();
    const result = await assembleCoauthorPrompt(makeInput(loaders, { branchId: "br_1" as never }));
    expect(result.promptTraceDraft.presetName).toBe("(coauthor)");
    expect(result.promptTraceDraft.presetId).toBeNull();
    expect(result.promptTraceDraft.assembledLayers).toEqual([]);
    expect(result.promptTraceDraft.activatedLoreEntries).toEqual([]);
    expect(result.promptTraceDraft.branchId).toBe("br_1");
  });

  test("CA-13: active lorebook entries render as read-only context and carry into the trace", async () => {
    const entryA: ActiveLoreEntry = {
      id: "lore_a" as never,
      title: "The Shattered Crown",
      content: "An ancient crown broken into seven shards, each pulsing with cold light.",
      activationReason: { kind: "key_match", matchedKeys: ["crown"], matchCount: 1, scanState: "normal" },
    } as unknown as ActiveLoreEntry;
    const entryB: ActiveLoreEntry = {
      id: "lore_b" as never,
      title: "",
      content: "A constant world fact.",
      activationReason: { kind: "constant" },
    } as unknown as ActiveLoreEntry;
    const loaders = makeLoaders({ loreEntries: [entryA, entryB] });

    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;

    // Lore renders as a read-only reference section after the current card.
    expect(system).toContain("# Lorebook context (read-only reference");
    expect(system).toContain("The Shattered Crown");
    expect(system).toContain("cold light");
    // An untitled entry falls back to a placeholder header, content still present.
    expect(system).toContain("(untitled)");
    expect(system).toContain("A constant world fact.");

    // Trace carries the activated ids + per-entry detail (id/title/reason).
    expect(result.prompt.activatedLoreEntries).toEqual(["lore_a", "lore_b"]);
    expect(result.prompt.activatedLoreDetail).toEqual([
      { id: "lore_a", title: "The Shattered Crown", reason: entryA.activationReason },
      { id: "lore_b", title: "", reason: entryB.activationReason },
    ]);
    expect(result.promptTraceDraft.activatedLoreEntries).toEqual(["lore_a", "lore_b"]);
    expect(result.promptTraceDraft.activatedLoreDetail.map((d) => d.id)).toEqual(["lore_a", "lore_b"]);
  });

  test("CA-13: with no active lore the prompt carries no lore section (unchanged)", async () => {
    const loaders = makeLoaders({ loreEntries: [] });
    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;
    expect(system).not.toContain("Lorebook context");
    expect(result.prompt.activatedLoreEntries).toEqual([]);
    expect(result.promptTraceDraft.activatedLoreEntries).toEqual([]);
  });
});
