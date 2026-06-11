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

  // ─── Prompt trace order preservation ───────────────────────────────────

  it("keeps system messages inside messages instead of extracting them", async () => {
    const result = await prepareSdkMessages(baseMessages, { providerType: "openai_compat" });
    expect(result.systemPrompt).toBeUndefined();
    expect(result.conversationMessages).toEqual(baseMessages);
  });

  it("preserves multiple system messages in their original positions", async () => {
    const messages: SdkMessage[] = [
      { role: "system", content: "Rule 1." },
      { role: "user", content: "Hi" },
      { role: "system", content: "Rule 2." },
    ];
    const result = await prepareSdkMessages(messages, { providerType: "openai_compat" });
    expect(result.systemPrompt).toBeUndefined();
    expect(result.conversationMessages).toEqual(messages);
  });

  it("returns unchanged messages when no system messages", async () => {
    const messages: SdkMessage[] = [
      { role: "user", content: "Hello" },
    ];
    const result = await prepareSdkMessages(messages, { providerType: "openai_compat" });
    expect(result.systemPrompt).toBeUndefined();
    expect(result.conversationMessages).toEqual([{ role: "user", content: "Hello" }]);
  });

  // ─── Prefill injection ─────────────────────────────────────────────────

  it("appends assistant prefill for openai_compat after trace messages", async () => {
    const result = await prepareSdkMessages(baseMessages, {
      providerType: "openai_compat",
      prefill: "Sure, here is:",
    });
    expect(result.conversationMessages).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Sure, here is:" },
    ]);
  });

  it("appends assistant prefill for ollama", async () => {
    const result = await prepareSdkMessages(baseMessages, {
      providerType: "ollama",
      prefill: "Ollama prefill",
    });
    expect(result.conversationMessages).toHaveLength(3);
    expect(result.conversationMessages[2]).toEqual({ role: "assistant", content: "Ollama prefill" });
  });

  it("appends assistant prefill for llamacpp", async () => {
    const result = await prepareSdkMessages(baseMessages, {
      providerType: "llamacpp",
      prefill: "Llama prefill",
    });
    expect(result.conversationMessages).toHaveLength(3);
    expect(result.conversationMessages[2]).toEqual({ role: "assistant", content: "Llama prefill" });
  });

  it("does NOT append prefill for anthropic", async () => {
    const result = await prepareSdkMessages(baseMessages, {
      providerType: "anthropic",
      prefill: "Ignored",
    });
    expect(result.conversationMessages).toEqual(baseMessages);
  });

  it("does NOT append prefill for google", async () => {
    const result = await prepareSdkMessages(baseMessages, {
      providerType: "google",
      prefill: "Ignored",
    });
    expect(result.conversationMessages).toEqual(baseMessages);
  });

  it("does NOT append prefill when undefined", async () => {
    const result = await prepareSdkMessages(baseMessages, {
      providerType: "openai_compat",
      prefill: undefined,
    });
    expect(result.conversationMessages).toEqual(baseMessages);
  });

  it("does NOT append prefill when empty string", async () => {
    const result = await prepareSdkMessages(baseMessages, {
      providerType: "openai_compat",
      prefill: "",
    });
    expect(result.conversationMessages).toEqual(baseMessages);
  });

  // ─── Combined: trace order + prefill ───────────────────────────────────

  it("preserves system position and appends prefill after the trace messages", async () => {
    const messages: SdkMessage[] = [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Explain X" },
      { role: "system", content: "Answer in English." },
    ];
    const result = await prepareSdkMessages(messages, {
      providerType: "openai_compat",
      prefill: "Sure:",
    });
    expect(result.systemPrompt).toBeUndefined();
    expect(result.conversationMessages).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Explain X" },
      { role: "system", content: "Answer in English." },
      { role: "assistant", content: "Sure:" },
    ]);
  });
});
