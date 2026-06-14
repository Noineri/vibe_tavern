import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createOllamaModel, fetchOllamaModels } from "../src/domain/providers/ollama-adapter.js";

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

function mockJson(response: unknown, status = 200) {
  mockFetch = mock(async () => new Response(JSON.stringify(response), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
  globalThis.fetch = mockFetch as typeof fetch;
}

function mockNdjson(lines: unknown[], status = 200) {
  mockFetch = mock(async () => new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", {
    status,
    headers: { "Content-Type": "application/x-ndjson" },
  }));
  globalThis.fetch = mockFetch as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Ollama adapter — doGenerate", () => {
  it("posts to /api/chat and returns generated text", async () => {
    mockJson({
      model: "gemma3:4b",
      message: { role: "assistant", content: "Hello!" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 5,
      eval_count: 2,
    });

    const model = createOllamaModel({ baseURL: "http://localhost:11434", modelId: "gemma3:4b" });
    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      temperature: 0.7,
      maxOutputTokens: 64,
      providerOptions: { ollama: { top_k: 40, min_p: 0.05, repeat_penalty: 1.15 } },
    });

    expect(result.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(result.finishReason.unified).toBe("stop");
    expect(result.usage.inputTokens.total).toBe(5);
    expect(result.usage.outputTokens.total).toBe(2);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:11434/api/chat");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      model: "gemma3:4b",
      stream: false,
      messages: [{ role: "user", content: "Hi" }],
      options: {
        temperature: 0.7,
        num_predict: 64,
        top_k: 40,
        min_p: 0.05,
        repeat_penalty: 1.15,
      },
    });
  });

  it("serializes system/user/assistant messages", async () => {
    mockJson({ message: { role: "assistant", content: "ok" }, done: true });
    const model = createOllamaModel({ baseURL: "http://localhost:11434/", modelId: "qwen" });

    await model.doGenerate({
      prompt: [
        { role: "system", content: "Be concise." },
        { role: "user", content: [{ type: "text", text: "Hi" }] },
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      ],
    });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("throws on HTTP errors", async () => {
    mockFetch = mock(async () => new Response("bad", { status: 500 }));
    globalThis.fetch = mockFetch as typeof fetch;
    const model = createOllamaModel({ baseURL: "http://localhost:11434", modelId: "gemma3:4b" });

    await expect(model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    })).rejects.toThrow("Ollama generate error (500): bad");
  });
});

describe("Ollama adapter — doStream", () => {
  it("converts NDJSON chunks into text deltas and finish", async () => {
    mockNdjson([
      { message: { role: "assistant", content: "Hello" }, done: false },
      { message: { role: "assistant", content: " world" }, done: false },
      { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 3, eval_count: 2 },
    ]);

    const model = createOllamaModel({ baseURL: "http://localhost:11434", modelId: "gemma3:4b" });
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
    });

    const parts: unknown[] = [];
    for await (const part of result.stream) parts.push(part);

    expect(parts).toEqual([
      { type: "text-delta", id: "0", delta: "Hello" },
      { type: "text-delta", id: "0", delta: " world" },
      expect.objectContaining({ type: "finish", usage: expect.objectContaining({ inputTokens: expect.objectContaining({ total: 3 }) }) }),
    ]);

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.stream).toBe(true);
  });
});

describe("fetchOllamaModels", () => {
  it("returns completion-capable model names and filters embedding-only models", async () => {
    mockJson({
      models: [
        { name: "gemma3:4b", capabilities: ["completion"] },
        { name: "embed:latest", capabilities: ["embedding"] },
        { name: "legacy-no-capabilities" },
      ],
    });

    await expect(fetchOllamaModels("http://localhost:11434")).resolves.toEqual([
      "gemma3:4b",
      "legacy-no-capabilities",
    ]);
  });
});
