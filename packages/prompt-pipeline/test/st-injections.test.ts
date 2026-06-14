import { describe, expect, it } from "bun:test";
import { assemblePrompt } from "../src/assemble.ts";

describe("Prompt pipeline: ST custom injection semantics", () => {
  it("places relative ST prompt-order injections before chat with their configured role", () => {
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: {
        recentMessages: [
          { id: "m1", role: "user", content: "hello" },
          { id: "m2", role: "assistant", content: "hi" },
        ],
      },
      character: { id: "char_1", name: "Aria", description: "A mage." },
      preset: {
        id: "preset_1",
        text: "system prompt",
        advancedMode: true,
        customInjections: [
          { identifier: "relative_user", name: "Relative User", content: "relative instruction", role: "user" },
        ],
        promptOrder: [
          { identifier: "relative_user", enabled: true, zone: "before_chat", depth: null, order: 12, kind: "custom" },
        ],
      },
    });

    const relativeIndex = result.finalPayload.messages.findIndex((m) => m.layerId === "preset_injection_relative_user");
    const firstHistoryIndex = result.finalPayload.messages.findIndex((m) => m.messageId === "m1");

    expect(relativeIndex).toBeGreaterThan(-1);
    expect(firstHistoryIndex).toBeGreaterThan(-1);
    expect(relativeIndex).toBeLessThan(firstHistoryIndex);
    expect(result.finalPayload.messages[relativeIndex]!.role).toBe("user");
  });

  it("places relative ST prompt-order injections after chat when prompt_order puts them after chatHistory", () => {
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: {
        recentMessages: [
          { id: "m1", role: "user", content: "hello" },
          { id: "m2", role: "assistant", content: "hi" },
        ],
      },
      character: { id: "char_1", name: "Aria", description: "A mage." },
      preset: {
        id: "preset_1",
        text: "system prompt",
        advancedMode: true,
        customInjections: [
          { identifier: "relative_after_user", name: "Relative After User", content: "relative after chat instruction", role: "user" },
        ],
        promptOrder: [
          { identifier: "relative_after_user", enabled: true, zone: "after_chat", depth: null, order: 20, kind: "custom" },
        ],
      },
    });

    const afterIndex = result.finalPayload.messages.findIndex((m) => m.layerId === "preset_injection_relative_after_user");
    const lastHistoryIndex = result.finalPayload.messages.findIndex((m) => m.messageId === "m2");

    expect(afterIndex).toBeGreaterThan(-1);
    expect(lastHistoryIndex).toBeGreaterThan(-1);
    expect(afterIndex).toBe(lastHistoryIndex + 1);
    expect(result.finalPayload.messages[afterIndex]!.role).toBe("user");
  });

  it("places absolute ST injections at depth with their configured role and order bucket", () => {
    const result = assemblePrompt({
      identity: { chatId: "chat_1" },
      chat: {
        recentMessages: [
          { id: "m1", role: "user", content: "one" },
          { id: "m2", role: "assistant", content: "two" },
          { id: "m3", role: "user", content: "three" },
        ],
      },
      character: { id: "char_1", name: "Aria", description: "A mage." },
      preset: {
        id: "preset_1",
        text: "system prompt",
        advancedMode: true,
        customInjections: [
          { identifier: "absolute_user", name: "Absolute User", content: "absolute depth instruction", role: "user" },
        ],
        promptOrder: [
          { identifier: "absolute_user", enabled: true, zone: "in_chat", depth: 1, order: 200, kind: "custom" },
        ],
      },
    });

    const absoluteIndex = result.finalPayload.messages.findIndex((m) => m.layerId === "preset_injection_absolute_user");
    const lastHistoryIndex = result.finalPayload.messages.findIndex((m) => m.messageId === "m3");

    expect(absoluteIndex).toBeGreaterThan(-1);
    expect(lastHistoryIndex).toBeGreaterThan(-1);
    expect(absoluteIndex).toBe(lastHistoryIndex - 1);
    expect(result.finalPayload.messages[absoluteIndex]!.role).toBe("user");
  });
});
