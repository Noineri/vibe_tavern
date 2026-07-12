import { describe, expect, it } from "bun:test";
import type { StoreContainer } from "@vibe-tavern/db";
import { setTokenCountFn } from "@vibe-tavern/prompt-pipeline";
import type { AssemblePromptResponse, ChatBranchId, ChatId } from "@vibe-tavern/domain";
import { PromptAssemblyService, type PromptAssemblyResolver } from "../src/domain/prompt/prompt-assembly-service.js";
import { ChatLifecycleRuntime, type ChatLifecycleRuntimeDeps } from "../src/runtime/session/session-runtime-chat-lifecycle.js";
import { withSummaryPromptAsFinalUserMessage } from "../src/domain/chat/chat-summary-service.js";

const chat = {
  id: "chat_1",
  activeBranchId: "branch_1",
};

function assembled(prompt: AssemblePromptResponse = {
  layers: [],
  finalPayload: { messages: [] },
}): { branchId: ChatBranchId; prompt: AssemblePromptResponse; promptTraceDraft: never } {
  return { branchId: "branch_1" as ChatBranchId, prompt, promptTraceDraft: undefined as never };
}

function makeLifecycle(
  assemblePrompt: ChatLifecycleRuntimeDeps["assemblePrompt"],
  messages: Array<{ id: string; position: number }> = [],
) {
  const deps = {
    stores: {
      chats: { getById: async () => chat },
      messages: { getMessages: async () => messages },
    },
    assemblePrompt,
  } as unknown as ChatLifecycleRuntimeDeps;
  return new ChatLifecycleRuntime(deps);
}

describe("ChatLifecycleRuntime summary assembly", () => {
  it("passes the full-summary preparation parameters through unchanged", async () => {
    const calls: Array<Parameters<ChatLifecycleRuntimeDeps["assemblePrompt"]>> = [];
    const lifecycle = makeLifecycle(async (...args) => {
      calls.push(args);
      return assembled();
    });

    await lifecycle.assembleSummaryPrompt({
      chatId: "chat_1" as ChatId,
      model: "summary-model",
      recentMessageLimit: 24,
      contextBudget: 4096,
    });

    expect(calls).toEqual([[
      "chat_1",
      "branch_1",
      { model: "summary-model", recentMessageLimit: 24, contextBudget: 4096, summary: true },
    ]]);
  });

  it("selects exactly the requested inclusive range for ranged summaries", async () => {
    const calls: Array<Parameters<ChatLifecycleRuntimeDeps["assemblePrompt"]>> = [];
    const lifecycle = makeLifecycle(async (...args) => {
      calls.push(args);
      return assembled();
    }, [
      { id: "msg_1", position: 0 },
      { id: "msg_2", position: 1 },
      { id: "msg_3", position: 2 },
      { id: "msg_4", position: 3 },
    ]);

    await lifecycle.assembleRangedSummaryPrompt({
      chatId: "chat_1" as ChatId,
      model: "summary-model",
      summarizedFrom: 2,
      summarizedTo: 3,
      contextBudget: 2048,
    });

    expect(calls).toEqual([[
      "chat_1",
      "branch_1",
      {
        model: "summary-model",
        recentMessageLimit: 4,
        excludeMessageIds: ["msg_1", "msg_4"],
        contextBudget: 2048,
        summary: true,
      },
    ]]);
  });
});

const summaryPrompt: AssemblePromptResponse = {
  layers: [
    { id: "character_base", text: "Character context" },
    { id: "prompt_preset_summary", text: "Summarize the case." },
  ],
  finalPayload: {
    messages: [
      { role: "system", content: "Character context", layerId: "character_base" },
      { role: "system", content: "Summarize the case.", layerId: "prompt_preset_summary" },
    ],
  },
};

describe("PromptAssemblyService summary preparation", () => {
  it("keeps the summary-only loading rules and pins compaction against excluded layers", async () => {
    const messages = [
      { id: "msg_1", position: 0, role: "user", content: "one two three", branchId: "branch_1" },
      { id: "msg_2", position: 1, role: "assistant", content: "four five six", branchId: "branch_1" },
      { id: "msg_3", position: 2, role: "user", content: "seven eight nine", branchId: "branch_1" },
      { id: "msg_4", position: 3, role: "assistant", content: "ten eleven twelve", branchId: "branch_1" },
    ];
    let summaryLoads = 0;
    let scriptMode: string | null = null;
    const stores = {
      chats: {
        getById: async () => ({ id: "chat_1", characterId: "char_1", personaId: "persona_1", promptPresetId: "preset_1", activeBranchId: "branch_1", messageHistoryLimit: 0 }),
        getBranches: async () => [{ id: "branch_1" }],
      },
      messages: { getMessages: async () => messages },
      personas: { listAll: async () => [{ id: "persona_1", defaultForNewChats: true }] },
      chatSummaries: { listByChatBranch: async () => { summaryLoads += 1; return []; } },
      characterAssets: { listByCharacter: async () => [] },
    } as unknown as StoreContainer;
    const resolver: PromptAssemblyResolver = {
      getCharacter: async () => ({ id: "char_1", name: "Nora", description: "character words that are excluded from the summary output", personality: null, scenario: null }),
      getPersona: async () => ({ id: "persona_1", name: "Alex", description: "persona words that are excluded from the summary output" }),
      getPromptPreset: async () => ({ id: "preset_1", name: "P", text: "preset words that are excluded from the summary output", summary: "Summarize this history.", jailbreak: "jailbreak words that are excluded from the summary output", tools: "", prefill: "", authorsNote: "", authorsNoteDepth: 0 }),
      listActiveLoreEntries: async () => [{ id: "lore_1", title: "Lore", content: "lore words that are excluded from the summary output", priority: 1 }],
      listRetrievedMemories: async () => [],
      executeScripts: async (input) => {
        scriptMode = input.mode;
        return { personality: input.characterRecord.personality ?? "", scenario: input.characterRecord.scenario ?? "", injectedMessages: [], errors: [], scriptRuns: [] };
      },
      getToolInstructions: () => null,
    };
    const fileStore = { dataRoot: "/mock", resolvePath: () => "/mock", readJson: async <T>() => null as T, writeJson: async () => {}, asyncWriteJson: async () => {} };
    setTokenCountFn((text) => text.trim() ? text.trim().split(/\s+/).length : 0);
    try {
      const service = new PromptAssemblyService(stores, resolver, fileStore);
      const result = await service.assembleForChat({ chatId: "chat_1" as ChatId, model: "test-model", summary: true, contextBudget: 24 });
      const history = result.prompt.layers.find((layer) => layer.id === "recent_history");

      expect(summaryLoads).toBe(0);
      expect(scriptMode).toBe("summary");
      expect(history?.text).toBe("USER: seven eight nine\n\nASSISTANT: ten eleven twelve");
      expect(result.prompt.layers.map((layer) => layer.id)).toEqual([
        "persona",
        "character_base",
        "recent_history",
        "prompt_preset_summary",
      ]);
    } finally {
      setTokenCountFn(() => 0);
    }
  });
});

describe("ChatSummaryService summary prompt reshape", () => {
  it("moves the summary instruction to the final user message", () => {
    expect(withSummaryPromptAsFinalUserMessage(summaryPrompt).finalPayload).toEqual({
      messages: [
        { role: "system", content: "Character context", layerId: "character_base" },
        { role: "user", content: "Summarize the case.", layerId: "prompt_preset_summary" },
      ],
    });
  });
});
