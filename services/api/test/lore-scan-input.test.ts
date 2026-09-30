import { describe, expect, it } from "bun:test";
import type { StoreContainer } from "@vibe-tavern/db";
import {
  normalizeInsightsConfig,
  normalizeObjectiveState,
  type ChatId,
  type MessageId,
} from "@vibe-tavern/domain";
import {
  PromptAssemblyService,
  type PromptAssemblyResolver,
} from "../src/domain/prompt/prompt-assembly-service.js";

type PromptPreset = NonNullable<Awaited<ReturnType<PromptAssemblyResolver["getPromptPreset"]>>>;

interface ScanMessage {
  id: string;
  position: number;
  role: "user" | "assistant";
  content: string;
  branchId: string;
}

function makeService(messages: ScanMessage[], options: {
  summaries?: Array<{
    id: string;
    source: string;
    includeInContext: boolean;
    excludeSummarized: boolean;
    content: string;
    summarizedFrom: number;
    summarizedTo: number;
  }>;
  promptPreset?: PromptPreset;
  messageHistoryLimit?: number;
  onScanMessages: (messages: Array<{ role: string; content: string }>) => void;
  onLoreScanInput?: (input: Parameters<PromptAssemblyResolver["listActiveLoreEntries"]>[0]) => void;
}) {
  const stores = {
    chats: {
      getById: async () => ({
        id: "chat_1",
        characterId: "char_1",
        personaId: null,
        promptPresetId: options.promptPreset ? "preset_1" : null,
        activeBranchId: "branch_1",
        insightsConfig: normalizeInsightsConfig({}),
        insightsObjectiveState: normalizeObjectiveState({}),
        title: "Lore scan input",
        summary: null,
        messageHistoryLimit: options.messageHistoryLimit ?? 0,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      }),
      getBranches: async () => [{ id: "branch_1", chatId: "chat_1", parentBranchId: null, label: "main" }],
      getMessages: async () => [],
    },
    messages: { getMessages: async () => messages },
    personas: { listAll: async () => [] },
    presets: { listAll: async () => [] },
    chatSummaries: { listByChatBranch: async () => options.summaries ?? [] },
    characterAssets: { listByCharacter: async () => [] },
    diceRolls: { getRollsForMessages: async () => new Map() },
    experiences: { getAttachmentsForMessages: async () => new Map() },
  } as unknown as StoreContainer;
  const resolver: PromptAssemblyResolver = {
    getCharacter: async () => ({ id: "char_1", name: "Lorekeeper", description: "" }),
    getPersona: async () => null,
    getPromptPreset: async () => options.promptPreset ?? null,
    listActiveLoreEntries: async (input) => {
      options.onScanMessages(input.scanMessages);
      options.onLoreScanInput?.(input);
      return { entries: [], overflowedLorebooks: [] };
    },
    listRetrievedMemories: async () => [],
    executeScripts: async () => ({
      personality: "",
      scenario: null,
      injectedMessages: [],
      errors: [],
      scriptRuns: [],
    }),
    getToolInstructions: () => null,
  };
  const fileStore = {
    dataRoot: "/mock",
    resolvePath: (_folder: string, relativePath: string) => `/mock/${relativePath}`,
    readJson: async <T>() => null as T,
    writeJson: async () => {},
    asyncWriteJson: async () => {},
  };
  return new PromptAssemblyService(stores, resolver, fileStore);
}

function makePromptPreset(authorsNote: string): PromptPreset {
  return {
    id: "preset_1",
    name: "Lore scan preset",
    text: "",
    jailbreak: "",
    summary: "",
    tools: "",
    prefill: "",
    authorsNote,
    authorsNoteDepth: 4,
    authorsNotePosition: "in_chat",
    authorsNoteRole: "system",
    nsfw: "",
    enhanceDefinitions: "",
    advancedMode: false,
    mergeConsecutiveRoles: false,
    customInjections: [],
    promptOrder: [],
  };
}

function message(index: number, role: "user" | "assistant", content: string): ScanMessage {
  return {
    id: `msg_${index}`,
    position: index - 1,
    role,
    content,
    branchId: "branch_1",
  };
}

async function scanContents(
  messages: ScanMessage[],
  input: {
    excludeMessageIds?: MessageId[];
    throughMessageId?: MessageId;
  } = {},
  options: Omit<Parameters<typeof makeService>[1], "onScanMessages" | "onLoreScanInput"> = {},
): Promise<string[]> {
  let scanMessages: Array<{ role: string; content: string }> = [];
  const service = makeService(messages, {
    ...options,
    onScanMessages: (seen) => { scanMessages = seen; },
  });
  await service.assembleForChat({
    chatId: "chat_1" as ChatId,
    model: "test-model",
    ...input,
  });
  return scanMessages.map((scanMessage) => scanMessage.content);
}

describe("PromptAssemblyService lore scan input (P13)", () => {
  it("excludes the regenerate target from scanning while keeping earlier keys scannable", async () => {
    const messages = [
      message(1, "user", "kept-key"),
      message(2, "assistant", "regenerate-only-key"),
    ];

    expect(await scanContents(messages, {
      excludeMessageIds: ["msg_2" as MessageId],
    })).toEqual(["kept-key"]);
  });

  it("does not scan messages in an excluded summary range", async () => {
    const messages = [
      message(1, "user", "before-summary-key"),
      message(2, "assistant", "summary-only-key"),
      message(3, "user", "after-summary-key"),
    ];

    expect(await scanContents(messages, {}, {
      summaries: [{
        id: "summary_1",
        source: "manual",
        includeInContext: true,
        excludeSummarized: true,
        content: "summary",
        summarizedFrom: 2,
        summarizedTo: 2,
      }],
    })).toEqual(["before-summary-key", "after-summary-key"]);
  });

  it("does not scan messages after a scene-backfill throughMessageId", async () => {
    const messages = [
      message(1, "assistant", "prefix-key"),
      message(2, "user", "target-key"),
      message(3, "assistant", "future-only-key"),
    ];

    expect(await scanContents(messages, {
      throughMessageId: "msg_2" as MessageId,
    })).toEqual(["prefix-key", "target-key"]);
  });

  it("scans messages dropped only by the prompt history-limit window", async () => {
    const messages = [
      message(1, "user", "old-but-scannable-key"),
      message(2, "assistant", "recent-key"),
    ];

    expect(await scanContents(messages, {}, { messageHistoryLimit: 1 })).toEqual([
      "old-but-scannable-key",
      "recent-key",
    ]);
  });

  it("re-appends an excluded final user turn to the scan in normal chat mode", async () => {
    const messages = [
      message(1, "assistant", "kept-key"),
      message(2, "user", "final-user-key"),
    ];

    expect(await scanContents(messages, {
      excludeMessageIds: ["msg_2" as MessageId],
    })).toEqual(["kept-key", "final-user-key"]);
  });

  it("passes the effective Author's Note and only enabled summaries through the assembly seam (P15)", async () => {
    let scanInput: Parameters<PromptAssemblyResolver["listActiveLoreEntries"]>[0] | null = null;
    const service = makeService([], {
      promptPreset: makePromptPreset("effective-author-note"),
      summaries: [
        { id: "included", source: "manual", includeInContext: true, excludeSummarized: false, content: "included-summary", summarizedFrom: 1, summarizedTo: 1 },
        { id: "disabled", source: "manual", includeInContext: false, excludeSummarized: false, content: "disabled-summary", summarizedFrom: 1, summarizedTo: 1 },
        { id: "empty", source: "manual", includeInContext: true, excludeSummarized: false, content: "   ", summarizedFrom: 1, summarizedTo: 1 },
      ],
      onScanMessages: () => {},
      onLoreScanInput: (seen) => { scanInput = seen; },
    });

    await service.assembleForChat({
      chatId: "chat_1" as ChatId,
      model: "test-model",
    });

    expect(scanInput?.authorsNote).toBe("effective-author-note");
    expect(scanInput?.summaries).toEqual(["included-summary"]);
  });

  it("passes one-shot quiet-prompt text through the assembly seam", async () => {
    let scanInput: Parameters<PromptAssemblyResolver["listActiveLoreEntries"]>[0] | null = null;
    const service = makeService([], {
      onScanMessages: () => {},
      onLoreScanInput: (seen) => { scanInput = seen; },
    });

    await service.assembleForChat({
      chatId: "chat_1" as ChatId,
      model: "test-model",
      quietPrompt: "draft-only-key",
      dryRun: true,
    });

    expect(scanInput?.quietPrompt).toBe("draft-only-key");
    expect(scanInput?.dryRun).toBe(true);
  });
});
