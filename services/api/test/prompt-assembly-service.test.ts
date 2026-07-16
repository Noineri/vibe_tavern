import { describe, it, expect } from "bun:test";
import { PromptAssemblyService, type PromptAssemblyResolver, resolveObjectiveTaskContext, resolveObjectiveLongTermContext } from "../src/domain/prompt/prompt-assembly-service.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { ChatId, ChatBranchId, LoreEntry, MessageId, RetrievedMemoryHit } from "@vibe-tavern/domain";
import { OBJECTIVE_MODE, OBJECTIVE_TASK_STATUS } from "@vibe-tavern/domain";

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

const mockFileStore = {
  dataRoot: "/mock",
  resolvePath: (_folder: string, relativePath: string) => `/mock/${relativePath}`,
  readJson: async <T>() => null as T,
  writeJson: async () => {},
  asyncWriteJson: async () => {},
};

// ─── Tests ─────────────────────────────────────────────────────────────────

describe.skip("PromptAssemblyService", () => {
  it("assembles a prompt with system, character, persona, and history layers", async () => {
    const stores = createMockStores();
    const service = new PromptAssemblyService(stores, mockResolver, mockFileStore);
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
    const service = new PromptAssemblyService(stores, mockResolver, mockFileStore);
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
    const service = new PromptAssemblyService(stores, mockResolver, mockFileStore);

    expect(
      service.assembleForChat({ chatId: "missing" as ChatId, model: "x" }),
    ).rejects.toThrow("was not found");
  });

  it("excludes messages by ID when excludeMessageIds provided", async () => {
    const stores = createMockStores();
    const service = new PromptAssemblyService(stores, mockResolver, mockFileStore);
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
    const service = new PromptAssemblyService(stores, mockResolver, mockFileStore);
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
    const service = new PromptAssemblyService(stores, mockResolver, mockFileStore);
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
    const service = new PromptAssemblyService(stores, mockResolver, mockFileStore);
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
    const service = new PromptAssemblyService(stores, resolver, mockFileStore);
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
    const service = new PromptAssemblyService(stores, mockResolver, mockFileStore);
    const result = await service.assembleForChat({
      chatId: "chat_1" as ChatId,
      model: "test-model",
      recentMessageLimit: 5,
    });

    expect(result.prompt.tokenAccounting.recentHistory).toBe(5);
  });
});

// ─── D7: per-image gallery prompt inclusion filter ─────────────────────────
// The gallery filter lives in PromptAssemblyService.assembleForChat (the pure
// assemblePrompt receives an already-curated `gallery` array). These tests pin
// the exact filter line — `row.description?.trim() && row.includeInPrompt` —
// by driving the real service with a minimal mock store + fake resolver, so a
// silent regression (e.g. dropping the includeInPrompt clause, or inverting it)
// is caught. Self-contained: does not touch the legacy skipped suite above.

function makeFilterService(
  galleryRows: Array<{
    id: string;
    description: string | null;
    includeInPrompt: boolean;
    caption?: string;
  }>,
  options?: {
    includeGalleryInPrompt?: boolean;
    messages?: Array<{ id: string; position: number; role: "user" | "assistant"; content: string; branchId: string }>;
  },
) {
  const includeGalleryInPrompt = options?.includeGalleryInPrompt ?? true;
  const messages = options?.messages ?? [];

  const stores = {
    chats: {
      getById: async () => ({
        id: "chat_1",
        characterId: "char_1",
        personaId: null,
        promptPresetId: null,
        activeBranchId: "branch_1",
        title: "T",
        summary: null,
        messageHistoryLimit: 0,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      }),
      getBranches: async () => [{ id: "branch_1", chatId: "chat_1", parentBranchId: null, label: "main" }],
      getMessages: async () => [],
    },
    messages: { getMessages: async () => messages },
    personas: { listAll: async () => [] },
    presets: { listAll: async () => [] },
    chatSummaries: { listByChatBranch: async () => [] },
    characterAssets: {
      listByCharacter: async () =>
        galleryRows.map((r) => ({
          id: r.id,
          characterId: "char_1",
          ext: "png",
          mimeType: "image/png",
          caption: r.caption ?? "",
          description: r.description,
          includeInPrompt: r.includeInPrompt,
          order: 0,
          createdAt: "2025-01-01T00:00:00Z",
        })),
    },
  } as unknown as StoreContainer;

  const resolver: PromptAssemblyResolver = {
    getCharacter: async () => ({
      id: "char_1",
      name: "Aria",
      description: "A fire mage.",
      personality: "Bold.",
      includeGalleryInPrompt,
    }),
    getPersona: async () => null,
    getPromptPreset: async () => null,
    listActiveLoreEntries: async () => [],
    listRetrievedMemories: async () => [],
    executeScripts: async () => ({ personality: "Bold.", scenario: null, injectedMessages: [], errors: [], scriptRuns: [] }),
    getToolInstructions: () => null,
  };

  return new PromptAssemblyService(stores, resolver, mockFileStore);
}

describe("PromptAssemblyService gallery includeInPrompt filter (D7)", () => {
  it("injects only described + includeInPrompt rows", async () => {
    const service = makeFilterService([
      { id: "row_a", description: "A black battle dress.", includeInPrompt: true, caption: "outfit" },
      { id: "row_b", description: "A flaming staff.", includeInPrompt: false, caption: "weapon" }, // selected off
      { id: "row_c", description: null, includeInPrompt: true, caption: "undescribed" }, // undescribed
      { id: "row_d", description: "A crimson cloak.", includeInPrompt: true, caption: "cloak" },
    ]);

    const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "test-model" });
    const layer = result.prompt.layers.find((l) => l.id === "character_gallery");

    expect(layer, "gallery layer must emit when master toggle on + >=1 selected/described row").toBeTruthy();
    const text = layer!.text;
    expect(text).toContain("battle dress"); // row_a
    expect(text).toContain("crimson cloak"); // row_d
    expect(text).not.toContain("flaming staff"); // row_b: includeInPrompt false
    expect(text).not.toContain("undescribed"); // row_c: no description (caption not rendered either)
  });

  it("suppresses the gallery layer entirely when no described+selected rows remain", async () => {
    const service = makeFilterService([
      { id: "row_b", description: "A flaming staff.", includeInPrompt: false },
      { id: "row_c", description: null, includeInPrompt: true },
    ]);
    const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "test-model" });
    expect(result.prompt.layers.find((l) => l.id === "character_gallery")).toBeUndefined();
  });

  it("injects regardless of the deprecated master includeGalleryInPrompt toggle", async () => {
    // Per-image includeInPrompt is the sole gate now; the character-level
    // master toggle is no longer read by the assembly service.
    for (const includeGalleryInPrompt of [false, true] as const) {
      const service = makeFilterService(
        [{ id: "row_a", description: "A black battle dress.", includeInPrompt: true }],
        { includeGalleryInPrompt },
      );
      const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "test-model" });
      expect(
        result.prompt.layers.find((l) => l.id === "character_gallery"),
        `includeGalleryInPrompt=${includeGalleryInPrompt}`,
      ).toBeDefined();
    }
  });
});

describe("PromptAssemblyService ranged summaries", () => {
  const messages = Array.from({ length: 81 }, (_, index) => ({
    id: `msg_${index + 1}`,
    position: index,
    role: index === 80 ? "user" as const : index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `Message ${index + 1}`,
    branchId: "branch_1",
  }));
  const excludedMessageIds = messages.slice(60).map((message) => message.id as MessageId);

  it("honors the selected range in summary mode but retains the send safeguard in chat mode", async () => {
    const service = makeFilterService([], { messages });

    const summary = await service.assembleForChat({
      chatId: "chat_1" as ChatId,
      model: "test-model",
      summary: true,
      excludeMessageIds: excludedMessageIds,
    });
    const summaryContents = (summary.prompt.finalPayload as { messages: Array<{ content: string }> }).messages
      .map((message) => message.content)
      .join("\n");
    expect(summaryContents).toContain("Message 60");
    expect(summaryContents).not.toContain("Message 61");
    expect(summaryContents).not.toContain("Message 81");

    const chat = await service.assembleForChat({
      chatId: "chat_1" as ChatId,
      model: "test-model",
      mode: "chat",
      excludeMessageIds: excludedMessageIds,
    });
    const chatContents = (chat.prompt.finalPayload as { messages: Array<{ content: string }> }).messages
      .map((message) => message.content)
      .join("\n");
    expect(chatContents).toContain("Message 81");
  });
});

describe("PromptAssemblyService prefix-bound window (Scene backfill — SCENE_TRACKER_STATE_LIFECYCLE step 4)", () => {
  // a1(greeting), u1, a2, u2, a3, u3(FUTURE). Backfill targets the assistant
  // turns msg_1/msg_3/msg_5 in order; each context must end at its own target.
  const messages = [
    { id: "msg_1", position: 0, role: "assistant" as const, content: "Backfill turn 1 — greeting", branchId: "branch_1" },
    { id: "msg_2", position: 1, role: "user" as const, content: "Backfill turn 2 — user", branchId: "branch_1" },
    { id: "msg_3", position: 2, role: "assistant" as const, content: "Backfill turn 3 — assistant", branchId: "branch_1" },
    { id: "msg_4", position: 3, role: "user" as const, content: "Backfill turn 4 — user", branchId: "branch_1" },
    { id: "msg_5", position: 4, role: "assistant" as const, content: "Backfill turn 5 — assistant", branchId: "branch_1" },
    { id: "msg_6", position: 5, role: "user" as const, content: "Backfill turn 6 — FUTURE", branchId: "branch_1" },
  ];

  async function boundedWindow(throughMessageId: MessageId, recentMessageLimit?: number): Promise<string[]> {
    const service = makeFilterService([], { messages });
    const result = await service.assembleForChat({
      chatId: "chat_1" as ChatId,
      model: "test-model",
      throughMessageId,
      ...(recentMessageLimit === undefined ? {} : { recentMessageLimit }),
    });
    return (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages
      .map((message) => message.content)
      .filter((content) => content.startsWith("Backfill turn"));
  }

  it("builds progressive 1-message → 3-message → bounded-prefix contexts without future turns", async () => {
    expect(await boundedWindow("msg_1" as MessageId)).toEqual([
      "Backfill turn 1 — greeting",
    ]);
    expect(await boundedWindow("msg_3" as MessageId)).toEqual([
      "Backfill turn 1 — greeting",
      "Backfill turn 2 — user",
      "Backfill turn 3 — assistant",
    ]);
    // contextWindow=3 is applied AFTER prefixing through msg_5: keep turns 3–5,
    // never append the global last-user turn msg_6 from the future.
    expect(await boundedWindow("msg_5" as MessageId, 3)).toEqual([
      "Backfill turn 3 — assistant",
      "Backfill turn 4 — user",
      "Backfill turn 5 — assistant",
    ]);
  });

  it("without throughMessageId the normal window still includes the latest user turn", async () => {
    const service = makeFilterService([], { messages });
    const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "test-model" });
    const contents = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages
      .map((message) => message.content)
      .join("\n");
    expect(contents).toContain("Backfill turn 6 — FUTURE");
  });
});

describe("resolveObjectiveTaskContext + resolveObjectiveLongTermContext (OGM)", () => {
  const enabled = { objectiveEnabled: true };

  it("route mode: resolves the active route task as objectiveTask (first 'active' wins); long-term is null", () => {
    const result = resolveObjectiveTaskContext({
      insightsConfig: enabled,
      insightsObjectiveState: {
        mode: OBJECTIVE_MODE.route,
        tasks: [
          { id: "t1", description: "First", status: OBJECTIVE_TASK_STATUS.pending },
          { id: "t2", description: "Second", status: OBJECTIVE_TASK_STATUS.active },
        ],
        injectionDepth: 2,
        injectPrompt: "FRAME",
      },
    });
    expect(result?.description).toBe("Second");
    expect(result?.injectionDepth).toBe(2);
    expect(result?.injectPrompt).toBe("FRAME");
    // route mode never injects a long-term goal
    expect(resolveObjectiveLongTermContext({
      insightsConfig: enabled,
      insightsObjectiveState: { mode: OBJECTIVE_MODE.route },
    })).toBeNull();
  });

  it("goals mode: resolves the selected short-term as objectiveTask (NOT the route tasks)", () => {
    const result = resolveObjectiveTaskContext({
      insightsConfig: enabled,
      insightsObjectiveState: {
        mode: OBJECTIVE_MODE.goals,
        tasks: [{ id: "t1", description: "Route task ignored in goals mode", status: OBJECTIVE_TASK_STATUS.active }],
        shortTermGoals: [
          { id: "s1", description: "Short A", status: OBJECTIVE_TASK_STATUS.pending },
          { id: "s2", description: "Short B", status: OBJECTIVE_TASK_STATUS.active },
        ],
        injectionDepth: 1,
      },
    });
    expect(result?.description).toBe("Short B");
  });

  it("goals mode: long-term resolves while pending/active; null when completed/abandoned", () => {
    const resolve = (status: string) =>
      resolveObjectiveLongTermContext({
        insightsConfig: enabled,
        insightsObjectiveState: { mode: OBJECTIVE_MODE.goals, longTermGoal: { description: "Free the city", status } },
      });
    expect(resolve(OBJECTIVE_TASK_STATUS.pending)?.description).toBe("Free the city");
    expect(resolve(OBJECTIVE_TASK_STATUS.active)?.description).toBe("Free the city");
    expect(resolve(OBJECTIVE_TASK_STATUS.completed)).toBeNull();
    expect(resolve(OBJECTIVE_TASK_STATUS.abandoned)).toBeNull();
  });

  it("returns null when objective is disabled, no goal/list, or goals-mode has an empty short-term list", () => {
    const disabled = { objectiveEnabled: false };
    expect(resolveObjectiveTaskContext({ insightsConfig: disabled, insightsObjectiveState: { mode: OBJECTIVE_MODE.goals, shortTermGoals: [] } })).toBeNull();
    expect(resolveObjectiveLongTermContext({ insightsConfig: disabled, insightsObjectiveState: { mode: OBJECTIVE_MODE.goals } })).toBeNull();
    // goals mode, no long-term set
    expect(resolveObjectiveLongTermContext({ insightsConfig: enabled, insightsObjectiveState: { mode: OBJECTIVE_MODE.goals } })).toBeNull();
    // goals mode, empty short-term list → no active task
    expect(resolveObjectiveTaskContext({ insightsConfig: enabled, insightsObjectiveState: { mode: OBJECTIVE_MODE.goals, shortTermGoals: [] } })).toBeNull();
  });
});
