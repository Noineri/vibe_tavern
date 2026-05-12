import { describe, it, expect } from "bun:test";
import {
  toSdkMessages,
  prepareSdkMessages,
} from "../src/ai/provider-executor-utils.js";
import type { SdkMessage } from "../src/ai/provider-executor-utils.js";

// ═══════════════════════════════════════════════════════════════════════════
// toSdkMessages
// ═══════════════════════════════════════════════════════════════════════════

describe("toSdkMessages", () => {
  // ─── Happy path ────────────────────────────────────────────────────────

  it("parses valid messages from finalPayload", () => {
    const result = toSdkMessages({
      finalPayload: {
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there" },
        ],
      },
    });
    expect(result).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);
  });

  // ─── Empty / missing payload ───────────────────────────────────────────

  it("returns empty array when finalPayload is undefined", () => {
    expect(toSdkMessages({})).toEqual([]);
  });

  it("returns empty array when finalPayload is null", () => {
    expect(toSdkMessages({ finalPayload: null })).toEqual([]);
  });

  it("returns empty array when messages is missing", () => {
    expect(toSdkMessages({ finalPayload: {} })).toEqual([]);
  });

  it("returns empty array when messages is empty", () => {
    expect(toSdkMessages({ finalPayload: { messages: [] } })).toEqual([]);
  });

  // ─── Invalid entries are filtered out ──────────────────────────────────

  it("filters out entries with non-string role", () => {
    const result = toSdkMessages({
      finalPayload: {
        messages: [
          { role: 42, content: "bad" },
          { role: "user", content: "good" },
        ],
      },
    });
    expect(result).toEqual([{ role: "user", content: "good" }]);
  });

  it("filters out entries with non-string content", () => {
    const result = toSdkMessages({
      finalPayload: {
        messages: [
          { role: "user", content: 123 },
          { role: "assistant", content: "good" },
        ],
      },
    });
    expect(result).toEqual([{ role: "assistant", content: "good" }]);
  });

  it("filters out entries with unknown role", () => {
    const result = toSdkMessages({
      finalPayload: {
        messages: [
          { role: "tool", content: "some output" },
          { role: "function", content: "some output" },
          { role: "user", content: "valid" },
        ],
      },
    });
    expect(result).toEqual([{ role: "user", content: "valid" }]);
  });

  it("filters out null entries", () => {
    const result = toSdkMessages({
      finalPayload: {
        messages: [null, { role: "user", content: "ok" }, null],
      },
    });
    expect(result).toEqual([{ role: "user", content: "ok" }]);
  });

  it("filters out non-object entries (primitives)", () => {
    const result = toSdkMessages({
      finalPayload: {
        messages: ["string", 42, true, { role: "user", content: "ok" }],
      },
    });
    expect(result).toEqual([{ role: "user", content: "ok" }]);
  });

  it("handles mixed valid and invalid entries", () => {
    const result = toSdkMessages({
      finalPayload: {
        messages: [
          null,
          { role: "system", content: "System prompt" },
          { role: 999, content: "bad role" },
          { role: "user", content: "Hello" },
          { role: "assistant", content: 42 },
          "garbage",
          { role: "assistant", content: "Hi" },
        ],
      },
    });
    expect(result).toEqual([
      { role: "system", content: "System prompt" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ]);
  });

  // ─── Edge: messages is not an array ────────────────────────────────────

  it("returns empty array when messages is a string", () => {
    expect(toSdkMessages({ finalPayload: { messages: "not an array" } })).toEqual([]);
  });

  it("returns empty array when messages is a number", () => {
    expect(toSdkMessages({ finalPayload: { messages: 42 } })).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// prepareSdkMessages
// ═══════════════════════════════════════════════════════════════════════════

describe("prepareSdkMessages", () => {
  const baseMessages: SdkMessage[] = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello" },
  ];

  // ─── System message extraction ─────────────────────────────────────────

  it("extracts system messages into systemPrompt", () => {
    const result = prepareSdkMessages(baseMessages, { providerType: "openai_compat" });
    expect(result.systemPrompt).toBe("You are helpful.");
    expect(result.conversationMessages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("joins multiple system messages with double newline", () => {
    const messages: SdkMessage[] = [
      { role: "system", content: "Rule 1." },
      { role: "system", content: "Rule 2." },
      { role: "user", content: "Hi" },
    ];
    const result = prepareSdkMessages(messages, { providerType: "openai_compat" });
    expect(result.systemPrompt).toBe("Rule 1.\n\nRule 2.");
    expect(result.conversationMessages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("returns undefined systemPrompt when no system messages", () => {
    const messages: SdkMessage[] = [
      { role: "user", content: "Hello" },
    ];
    const result = prepareSdkMessages(messages, { providerType: "openai_compat" });
    expect(result.systemPrompt).toBeUndefined();
    expect(result.conversationMessages).toEqual([{ role: "user", content: "Hello" }]);
  });

  // ─── Prefill injection ─────────────────────────────────────────────────

  it("appends assistant prefill for openai_compat", () => {
    const result = prepareSdkMessages(baseMessages, {
      providerType: "openai_compat",
      prefill: "Sure, here is:",
    });
    expect(result.conversationMessages).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Sure, here is:" },
    ]);
  });

  it("appends assistant prefill for ollama", () => {
    const result = prepareSdkMessages(baseMessages, {
      providerType: "ollama",
      prefill: "Ollama prefill",
    });
    expect(result.conversationMessages).toHaveLength(2);
    expect(result.conversationMessages[1]).toEqual({ role: "assistant", content: "Ollama prefill" });
  });

  it("appends assistant prefill for llamacpp", () => {
    const result = prepareSdkMessages(baseMessages, {
      providerType: "llamacpp",
      prefill: "Llama prefill",
    });
    expect(result.conversationMessages).toHaveLength(2);
    expect(result.conversationMessages[1]).toEqual({ role: "assistant", content: "Llama prefill" });
  });

  it("does NOT append prefill for anthropic", () => {
    const result = prepareSdkMessages(baseMessages, {
      providerType: "anthropic",
      prefill: "Ignored",
    });
    expect(result.conversationMessages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("does NOT append prefill for google", () => {
    const result = prepareSdkMessages(baseMessages, {
      providerType: "google",
      prefill: "Ignored",
    });
    expect(result.conversationMessages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("does NOT append prefill when undefined", () => {
    const result = prepareSdkMessages(baseMessages, {
      providerType: "openai_compat",
      prefill: undefined,
    });
    expect(result.conversationMessages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("does NOT append prefill when empty string", () => {
    const result = prepareSdkMessages(baseMessages, {
      providerType: "openai_compat",
      prefill: "",
    });
    expect(result.conversationMessages).toEqual([{ role: "user", content: "Hello" }]);
  });

  // ─── Combined: system + prefill ────────────────────────────────────────

  it("handles system extraction + prefill together", () => {
    const messages: SdkMessage[] = [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Explain X" },
    ];
    const result = prepareSdkMessages(messages, {
      providerType: "openai_compat",
      prefill: "Sure:",
    });
    expect(result.systemPrompt).toBe("Be concise.");
    expect(result.conversationMessages).toEqual([
      { role: "user", content: "Explain X" },
      { role: "assistant", content: "Sure:" },
    ]);
  });
});
