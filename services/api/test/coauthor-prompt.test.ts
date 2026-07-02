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
  loreEntries: Array<{ id: string; title: string; content: string }>;
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
    getCoauthorLorebookEntries: async () => overrides?.loreEntries ?? [],
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

  test("CA-13: bound lorebook entries render as read-only reference in the system message", async () => {
    const entryA = {
      id: "lore_a",
      title: "The Shattered Crown",
      content: "An ancient crown broken into seven shards, each pulsing with cold light.",
    };
    const entryB = {
      id: "lore_b",
      title: "",
      content: "A constant world fact.",
    };
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

    // Co-author does NOT run the activation engine — trace lore fields stay
    // empty (no fabricated activation reasons for user-picked entries).
    expect(result.prompt.activatedLoreEntries).toEqual([]);
    expect(result.prompt.activatedLoreDetail).toEqual([]);
    expect(result.promptTraceDraft.activatedLoreEntries).toEqual([]);
  });

  test("CA-13: with no lorebooks bound the prompt carries no lore section (unchanged)", async () => {
    const loaders = makeLoaders({ loreEntries: [] });
    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;
    expect(system).not.toContain("Lorebook context");
    expect(result.prompt.activatedLoreEntries).toEqual([]);
    expect(result.promptTraceDraft.activatedLoreEntries).toEqual([]);
  });
  test("CS-0d: honours excludeMessageIds in prompt assembly", async () => {
    const loaders = makeLoaders({
      messages: [
        { id: "msg_1", role: "user", content: "hello" } as never,
        { id: "msg_2", role: "assistant", content: "on it" } as never,
      ],
    });
    const result = await assembleCoauthorPrompt(makeInput(loaders, { excludeMessageIds: ["msg_2"] }));
    const messages = (result.prompt.finalPayload as any).messages;
    
    // system + user, msg_2 is excluded
    expect(messages.length).toBe(2);
    expect(messages[1]).toEqual({ role: "user", content: "hello" });
  });

  test("CS-4: includes tool messages and assistant toolCalls in history assembly", async () => {
    const loaders = makeLoaders({
      messages: [
        { id: "msg_1", role: "user", content: "rewrite it" } as never,
        { 
          id: "msg_2", 
          role: "assistant", 
          content: "calling tool",
          toolCalls: [{ id: "call_1", name: "edit_section", args: { section: "PERSONALITY" } }]
        } as never,
        { id: "msg_3", role: "tool", toolCallId: "call_1", content: "Success" } as never,
      ],
    });
    const result = await assembleCoauthorPrompt(makeInput(loaders));
    const messages = (result.prompt.finalPayload as any).messages;
    
    expect(messages.length).toBe(4); // system + user + assistant + tool
    
    expect(messages[2].role).toBe("assistant");
    expect(messages[2].toolCalls).toEqual([{
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "edit_section",
      args: { section: "PERSONALITY" }
    }]);

    expect(messages[3].role).toBe("tool");
    expect(messages[3].content).toEqual([{
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "",
      result: "Success"
    }]);
  });

  test("CS-5: applies token compaction and preserves tool-call pairs", async () => {
    // Inject a fake token counter for this test so estimateTokens doesn't return 0
    const { setTokenCountFn } = await import("@vibe-tavern/prompt-pipeline");
    setTokenCountFn((text: string) => text.length);

    const loaders = makeLoaders({
      messages: [
        { id: "msg_0", role: "user", content: "very old message ".repeat(2000) } as never,
        { id: "msg_1", role: "user", content: "rewrite it" } as never,
        { 
          id: "msg_2", 
          role: "assistant", 
          content: "calling tool",
          toolCalls: [{ id: "call_1", name: "edit_section", args: { section: "PERSONALITY" } }]
        } as never,
        { id: "msg_3", role: "tool", toolCallId: "call_1", content: "Success" } as never,
      ],
    });
    // System prompt size + recent messages ~ some characters. 
    // Budget 15000 allows system + msg_1,2,3 but drops msg_0 (which is ~34000 chars)
    const result = await assembleCoauthorPrompt(makeInput(loaders, { contextBudget: 15000 }));
    const messages = (result.prompt.finalPayload as any).messages;
    
    // We expect system + msg_1 + msg_2 + msg_3
    expect(messages.length).toBe(4);
    expect(messages[1].content).toBe("rewrite it");
    expect(messages[2].role).toBe("assistant");
    expect(messages[3].role).toBe("tool");

    expect(result.prompt.tokenAccounting?.recentHistory).toBe(3);
    expect(result.promptTraceDraft.compactionSummary).toBeDefined();
    expect(result.promptTraceDraft.compactionSummary).toContain("Kept 3 of 4 recent messages");
  });
});
