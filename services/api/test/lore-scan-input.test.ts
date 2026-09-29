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

interface ScanMessage {
  id: string;
  position: number;
  role: "user" | "assistant";
  content: string;
  branchId: string;
}

function makeService(messages: ScanMessage[], options: {
  summaries?: Array<{
    includeInContext: boolean;
    excludeSummarized: boolean;
    content: string;
    summarizedFrom: number;
    summarizedTo: number;
  }>;
  messageHistoryLimit?: number;
  onScanMessages: (messages: Array<{ role: string; content: string }>) => void;
}) {
  const stores = {
    chats: {
      getById: async () => ({
        id: "chat_1",
        characterId: "char_1",
        personaId: null,
        promptPresetId: null,
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
    getPromptPreset: async () => null,
    listActiveLoreEntries: async (input) => {
      options.onScanMessages(input.scanMessages);
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
  options: Omit<Parameters<typeof makeService>[1], "onScanMessages"> = {},
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
});
