import { describe, it, expect } from "bun:test";
import { PromptAssemblyService, type PromptAssemblyResolver } from "../src/prompt-assembly-service.js";
import type { StoreContainer } from "@rp-platform/db";
import type { ChatId, ChatBranchId, LoreEntry, MessageId, RetrievedMemoryHit } from "@rp-platform/domain";

// ─── Mock helpers ──────────────────────────────────────────────────────────

function createMockStores(overrides?: Partial<StoreContainer["chats"]>): StoreContainer {
  return {
    chats: {
      getById: async () => ({
        id: "chat_1",
        characterId: "char_1",
        personaId: "persona_1",
        promptPresetId: "preset_1",
        activeBranchId: "branch_1",
        title: "Test Chat",
        summary: null,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      }),
      getBranches: async () => [
        { id: "branch_1", chatId: "chat_1", parentBranchId: null, label: "main" },
      ],
      getMessages: async () => [
        { id: "msg_1", role: "user", content: "Hello!", branchId: "branch_1" },
        { id: "msg_2", role: "assistant", content: "Hi there!", branchId: "branch_1" },
      ],
      ...overrides,
    },
    personas: {
      listAll: async () => [{ id: "persona_1", name: "User", description: "A user.", defaultForNewChats: true }],
    },
  } as unknown as StoreContainer;
}

const mockResolver: PromptAssemblyResolver = {
  getCharacter: async () => ({
    id: "char_1",
    name: "TestBot",
    description: "A test character.",
    scenario: "A test scenario.",
    systemPrompt: "You are TestBot.",
    personality: "Friendly.",
    mesExample: null,
    postHistoryInstructions: null,
  }),
  getPersona: async () => ({
    id: "persona_1",
    name: "User",
    description: "A regular user.",
  }),
  getPromptPreset: async () => ({
    id: "preset_1",
    name: "Default",
    text: "Write {{char}}'s next reply.",
    jailbreak: "",
    summary: "",
    tools: "",
    prefill: "",
    authorsNote: "",
    authorsNoteDepth: 4,
  }),
  listActiveLoreEntries: async () => [],
  listRetrievedMemories: async () => [],
  getToolInstructions: () => null,
};

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("PromptAssemblyService", () => {
  it("assembles a prompt with system, character, persona, and history layers", async () => {
    const stores = createMockStores();
    const service = new PromptAssemblyService(stores, mockResolver);
    const result = await service.assembleForChat({
      chatId: "chat_1" as ChatId,
      model: "test-model",
    });

    expect(result.prompt).toBeDefined();
    expect(result.prompt.finalPayload).toBeDefined();
    expect(result.prompt.layers.length).toBeGreaterThan(0);

    const payload = result.prompt.finalPayload as { messages?: Array<{ role: string; content: string }> };
    expect(payload.messages).toBeDefined();
    expect(payload.messages!.length).toBeGreaterThan(0);

    // Should have system messages (preset + character)
    const systemMessages = payload.messages!.filter((m) => m.role === "system");
    expect(systemMessages.length).toBeGreaterThan(0);

    // Should have conversation messages
    const convMessages = payload.messages!.filter((m) => m.role !== "system");
    expect(convMessages.length).toBeGreaterThan(0);
  });

  it("resolves macros in assembled prompt", async () => {
    const stores = createMockStores();
    const service = new PromptAssemblyService(stores, mockResolver);
    const result = await service.assembleForChat({
      chatId: "chat_1" as ChatId,
      model: "test-model",
    });

    const payload = result.prompt.finalPayload as { messages?: Array<{ role: string; content: string }> };
    const allText = payload.messages!.map((m) => m.content).join(" ");

    // {{char}} and {{user}} should be resolved — not present in final output
    expect(allText).not.toContain("{{char}}");
    expect(allText).not.toContain("{{user}}");

    // Should contain resolved values
    expect(allText).toContain("TestBot");
  });

  it("throws when chat not found", async () => {
    const stores = createMockStores({
      getById: async () => null,
    });
    const service = new PromptAssemblyService(stores, mockResolver);

    expect(
      service.assembleForChat({ chatId: "missing" as ChatId, model: "x" }),
    ).rejects.toThrow("was not found");
  });

  it("excludes messages by ID when excludeMessageIds provided", async () => {
    const stores = createMockStores();
    const service = new PromptAssemblyService(stores, mockResolver);
    const result = await service.assembleForChat({
      chatId: "chat_1" as ChatId,
      model: "test-model",
      excludeMessageIds: ["msg_1" as MessageId],
    });

    const payload = result.prompt.finalPayload as { messages?: Array<{ content: string }> };
    const allContent = payload.messages!.map((m) => m.content).join(" ");
    // msg_1 was "Hello!" — after exclusion, it should not appear in conversation
    expect(allContent).not.toContain("Hello!");
  });

  it("produces a prompt trace draft with correct metadata", async () => {
    const stores = createMockStores();
    const service = new PromptAssemblyService(stores, mockResolver);
    const result = await service.assembleForChat({
      chatId: "chat_1" as ChatId,
      model: "test-model",
    });

    expect(result.promptTraceDraft).toBeDefined();
    expect(result.promptTraceDraft.model).toBe("test-model");
    expect(result.promptTraceDraft.presetName).toBe("Default");
    expect(result.promptTraceDraft.finalPayload).toBeDefined();
    expect(result.promptTraceDraft.assembledLayers.length).toBeGreaterThan(0);
  });

  it("returns branchId from the active branch", async () => {
    const stores = createMockStores();
    const service = new PromptAssemblyService(stores, mockResolver);
    const result = await service.assembleForChat({
      chatId: "chat_1" as ChatId,
      model: "test-model",
    });

    expect(result.branchId).toBe("branch_1");
  });

  it("uses chat summary when present", async () => {
    const stores = createMockStores({
      getById: async () => ({
        id: "chat_1",
        characterId: "char_1",
        personaId: "persona_1",
        promptPresetId: "preset_1",
        activeBranchId: "branch_1",
        title: "Summarized Chat",
        summary: "The characters met at a tavern.",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      }),
    });
    const service = new PromptAssemblyService(stores, mockResolver);
    const result = await service.assembleForChat({
      chatId: "chat_1" as ChatId,
      model: "test-model",
    });

    const summaryLayer = result.prompt.layers.find((l) => l.sourceType === "summary_memory");
    expect(summaryLayer).toBeDefined();
    expect(summaryLayer!.text).toContain("tavern");
  });

  it("passes prefill through from preset", async () => {
    const resolver: PromptAssemblyResolver = {
      ...mockResolver,
      getPromptPreset: async () => ({
        id: "preset_1",
        name: "With Prefill",
        text: "Write a reply.",
        jailbreak: "",
        summary: "",
        tools: "",
        prefill: "Sure, I will respond as TestBot:",
        authorsNote: "",
        authorsNoteDepth: 4,
      }),
    };
    const stores = createMockStores();
    const service = new PromptAssemblyService(stores, resolver);
    const result = await service.assembleForChat({
      chatId: "chat_1" as ChatId,
      model: "test-model",
    });

    expect(result.prompt.prefill).toBe("Sure, I will respond as TestBot:");
  });

  it("limits recent messages when recentMessageLimit is set", async () => {
    const manyMessages = Array.from({ length: 20 }, (_, i) => ({
      id: `msg_${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
      branchId: "branch_1",
    }));

    const stores = createMockStores({
      getMessages: async () => manyMessages,
    });
    const service = new PromptAssemblyService(stores, mockResolver);
    const result = await service.assembleForChat({
      chatId: "chat_1" as ChatId,
      model: "test-model",
      recentMessageLimit: 5,
    });

    expect(result.prompt.tokenAccounting.recentHistory).toBe(5);
  });
});
