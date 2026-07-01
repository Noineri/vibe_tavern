import { describe, expect, test } from "bun:test";
import {
  CoauthorModeStrategy,
  RpModeStrategy,
  getChatModeStrategy,
} from "../src/domain/chat/chat-mode-strategy.js";
import type { ChatModeAssembleInput } from "../src/domain/chat/chat-mode-strategy.js";

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
    const promptService = {
      assembleForChat: async (input: unknown) => {
        seen.push(input);
        return { branchId: "brn_test", prompt: { messages: [] }, promptTraceDraft: { presetId: null } };
      },
    } as unknown as ChatModeAssembleInput["promptService"];

    const strategy = new RpModeStrategy();
    const input: ChatModeAssembleInput = {
      promptService,
      chatId: "chat_test" as never,
      branchId: "brn_test" as never,
      model: "test-model",
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
      promptService: {} as never,
      chatId: "chat_test" as never,
      model: "test-model",
      loaders: {
        getMessages: async () => [],
        getCharacter: async () => ({ id: "char_test", firstMessage: "x", alternateGreetings: [] } as never),
        getProfileMdText: async () => "---\nname: Test\n---\n# PERSONALITY\nx\n",
      },
    };
    const out = await strategy.assemble(input);
    // CA-6: assemble is now real (no longer NOT_IMPLEMENTED) and emits the
    // editor tool set + maxSteps for the executor's tool-loop.
    expect(out.tools).toHaveProperty("edit_profile");
    expect(out.maxSteps).toBe(5);
  });

  test("resolveProvider is a passthrough (mirrors RP)", async () => {
    const strategy = new CoauthorModeStrategy();
    const profile = { id: "prov_test" } as never;
    const out = await strategy.resolveProvider({ chatId: "chat_test", profile, model: "m" });
    expect(out).toEqual({ chatId: "chat_test", profile, model: "m" });
  });
});
