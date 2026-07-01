import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { ChatModeAssembleInput, ChatModeAssembleLoaders } from "../src/domain/chat/chat-mode-strategy.js";
import { assembleCoauthorPrompt } from "../src/domain/chat/coauthor-prompt.js";
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
});
