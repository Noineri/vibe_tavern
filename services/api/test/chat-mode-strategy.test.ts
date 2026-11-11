import { describe, expect, test } from "bun:test";
import { brandId, type ChatBranchId, type ChatId } from "@vibe-tavern/domain";
import {
  CoauthorModeStrategy,
  RpModeStrategy,
  getChatModeStrategy,
} from "../src/domain/chat/chat-mode-strategy.js";
import type { ChatModeAssembleInput, ChatModeAssembleLoaders } from "../src/domain/chat/chat-mode-strategy.js";
import type {
  AssemblePromptForChatInput,
  PromptAssemblyService,
} from "../src/domain/prompt/prompt-assembly-service.js";
import { makeExecutorPrompt } from "./provider-boundary-test-builders.js";
import { makeChatRow } from "./insights-test-builders.js";
import { makeCharacterRow, makeProviderProfileRow } from "./copilot-test-builders.js";
import { strictTestDouble } from "./strict-test-double.js";

/** The loader set for the assemble inputs: coauthor's prompt builder reads
 *  these members; RP forwards them into assembleForChat untouched (its double
 *  records the input verbatim). Every member is a complete typed stub. */
function makeAssembleLoaders(): ChatModeAssembleLoaders {
  return {
    getChat: async () => makeChatRow({ id: "chat_test" }),
    getMessages: async () => [],
    getCharacter: async () => makeCharacterRow("char_test"),
    getProfileMdText: async () => "---\nname: Test\n---\n# PERSONALITY\nx\n",
    getCoauthorContextItems: async () => [],
    getCoauthorBoundResources: async () => ({ lorebooks: [], scripts: [] }),
    getChatSummaries: async () => [],
    getCoauthorUserModules: async () => [],
    getSkillCatalog: async () => [],
  };
}

/**
 * Characterization tests for the chat-mode strategy registry + the assemble
 * seam introduced in CA-2. These pin two invariants the rest of the plan
 * relies on: (1) RP resolution is unchanged and RP's assemble delegates to the
 * existing promptService.assembleForChat with RP behavior literally unmoved,
 * and (2) a coauthor chat resolves its strategy (so CA-3 per-chat resolution is
 * wired end-to-end) even though its assemble is still a NOT_IMPLEMENTED stub.
 */

describe("chat-mode strategy registry", () => {
  test("resolves RP for 'rp'", () => {
    const s = getChatModeStrategy("rp");
    expect(s).toBeInstanceOf(RpModeStrategy);
    expect(s.mode).toBe("rp");
  });

  test("resolves Co-Author for 'coauthor'", () => {
    const s = getChatModeStrategy("coauthor");
    expect(s).toBeInstanceOf(CoauthorModeStrategy);
    expect(s.mode).toBe("coauthor");
  });

  test("throws for an unimplemented mode (novel)", () => {
    // novel/group are reserved in CHAT_MODE but have no strategy yet.
    expect(() => getChatModeStrategy("novel")).toThrow(/Unsupported chat mode/);
  });
});

describe("RpModeStrategy.assemble", () => {
  test("delegates to promptService.assembleForChat, forwarding the input verbatim", async () => {
    const seen: unknown[] = [];
    // The strict double keeps the provided member compiler-checked against
    // the REAL PromptAssemblyService; the result is a complete-typed value
    // (the erased literal's fragments were missing the trace's required
    // columns and the assembler response's layers). The test discards the
    // return — every field here is inert.
    const promptService = strictTestDouble<PromptAssemblyService>(
      {
        assembleForChat: async (input: AssemblePromptForChatInput) => {
          seen.push(input);
          return {
            branchId: brandId<ChatBranchId>("brn_test"),
            prompt: makeExecutorPrompt({ finalPayload: { messages: [] } }),
            promptTraceDraft: {
              chatId: brandId<ChatId>("chat_test"),
              branchId: brandId<ChatBranchId>("brn_test"),
              model: "test-model",
              assembledLayers: [],
              tokenAccounting: {},
              activatedLoreEntries: [],
              activatedLoreDetail: [],
              scriptInjections: [],
              retrievedMemories: [],
              finalPayload: {},
              latencyMs: 0,
              presetId: null,
              presetName: null,
            },
          };
        },
      },
      "RpModeStrategy promptService",
    );

    const strategy = new RpModeStrategy();
    const input: ChatModeAssembleInput = {
      promptService,
      chatId: brandId<ChatId>("chat_test"),
      branchId: brandId<ChatBranchId>("brn_test"),
      model: "test-model",
      loaders: makeAssembleLoaders(),
    };

    await strategy.assemble(input);

    // The promptService must have been called exactly once, with the input
    // MINUS the promptService field (i.e. the plain AssemblePromptForChatInput).
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("promptService");
    expect(seen[0]).toMatchObject({ chatId: "chat_test", model: "test-model" });
  });
});

describe("CoauthorModeStrategy.assemble", () => {
  test("delegates to the coauthor prompt builder (returns tools + maxSteps)", async () => {
    const strategy = new CoauthorModeStrategy();
    const input: ChatModeAssembleInput = {
      // assembleCoauthorPrompt never reads promptService (grep-proven, 14b
      // precedent) — the UNSET double throws labeled if a path ever reaches it.
      promptService: strictTestDouble<PromptAssemblyService>({}, "CoauthorModeStrategy promptService"),
      chatId: brandId<ChatId>("chat_test"),
      model: "test-model",
      loaders: makeAssembleLoaders(),
    };
    const out = await strategy.assemble(input);
    // CA-6: assemble is now real (no longer NOT_IMPLEMENTED) and emits the
    // editor tool set + maxSteps for the executor's tool-loop.
    expect(out.tools).toHaveProperty("write_profile");
    // CTX-S4: read_skill_file is always available (catalog-driven skill access).
    expect(out.tools).toHaveProperty("read_skill_file");
    expect(out.maxSteps).toBe(20);
  });

  test("resolveProvider is a passthrough (mirrors RP)", async () => {
    const strategy = new CoauthorModeStrategy();
    const profile = makeProviderProfileRow({ id: "prov_test" });
    const out = await strategy.resolveProvider({ chatId: "chat_test", profile, model: "m" });
    expect(out).toEqual({ chatId: "chat_test", profile, model: "m" });
  });
});
