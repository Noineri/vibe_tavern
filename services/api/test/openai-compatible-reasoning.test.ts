import { describe, expect, it } from "bun:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

describe("AI SDK OpenAI-compatible reasoning", () => {
  it("natively separates both reasoning response field variants without rewriting the body", async () => {
    for (const reasoningField of ["reasoning_content", "reasoning"] as const) {
      const message = {
        role: "assistant",
        content: "Final answer",
        [reasoningField]: "Inspect context",
      };
      const payload = {
        id: `response-${reasoningField}`,
        object: "chat.completion",
        created: 1_700_000_000,
        model: "test-model",
        choices: [{ index: 0, message, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      };
      const fetch = Object.assign(
        async () => new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        }),
        { preconnect: () => {} },
      ) as typeof globalThis.fetch;
      const provider = createOpenAICompatible({
        name: "reasoning-test",
        apiKey: "test-key",
        baseURL: "https://example.test/v1",
        fetch,
      });

      const result = await generateText({
        model: provider.chatModel("test-model"),
        prompt: "Hello",
      });

      expect(result.text).toBe("Final answer");
      expect(result.reasoningText).toBe("Inspect context");
      expect(result.response.body).toEqual(payload);
    }
  });
});
