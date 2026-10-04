import { describe, it, expect } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { generateText } from "ai";

/**
 * SDK interplay characterization for the reasoning-effort mapping
 * (REASONING_EFFORT_ANTHROPIC_GOOGLE, part D).
 *
 * Pins, against the INSTALLED ai/@ai-sdk/* versions (not docs), that turning
 * the provider-neutral `reasoning` call setting on changes the outgoing body
 * ONLY by the effort envelope — nothing else is added, dropped, or rewritten.
 * The mapper (sampler-mapper.ts) forwards the stored effort as exactly these
 * settings; if an SDK upgrade changes the envelope or starts touching other
 * parameters, these tests go red before any request silently changes shape.
 *
 * Doubles: T2 — one seam per provider boundary. The fetch implementations are
 * injected into the provider factories (createAnthropic/createGoogle accept a
 * `fetch` option), so no globalThis patching is needed.
 */

/** Canonical JSON (recursively sorted keys) for order-insensitive compares. */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canon(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Capture the JSON bodies POSTed through an injected fetch. */
function captureFetch(responseBody: object): {
  bodies: Array<Record<string, unknown>>;
  fetch: typeof globalThis.fetch;
} {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = Object.assign(
    async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return new Response(JSON.stringify(responseBody), {
        headers: { "content-type": "application/json" },
      });
    },
    { preconnect: () => {} },
  ) as typeof globalThis.fetch;
  return { bodies, fetch };
}

/** Keys of `a` whose canonical value differs from `b`, plus keys only in one. */
function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys]
    .filter((k) => canon(a[k]) !== canon(b[k]))
    .sort();
}

const ANTHROPIC_RESPONSE = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-6",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

const GOOGLE_RESPONSE = {
  candidates: [
    {
      content: { role: "model", parts: [{ text: "ok" }] },
      finishReason: "STOP",
      index: 0,
    },
  ],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  modelVersion: "test-model",
};

const INTERACTIONS_RESPONSE = {
  status: "completed",
  steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }] }],
};

describe("reasoning effort SDK interplay (installed ai@7 / @ai-sdk 4.x)", () => {
  it("anthropic: reasoning adds the thinking/effort envelope and applies the documented thinking-vs-sampling interplay — nothing beyond", async () => {
    const { bodies, fetch } = captureFetch(ANTHROPIC_RESPONSE);
    const anthropic = createAnthropic({ apiKey: "test-key", fetch });
    const base = {
      model: anthropic("claude-sonnet-4-6"),
      prompt: "Hi",
      temperature: 0.9,
      topP: 0.95,
      topK: 80,
      maxOutputTokens: 4096,
    };

    await generateText(base);
    await generateText({ ...base, reasoning: "high" });

    expect(bodies).toHaveLength(2);
    const [off, on] = bodies;
    // Baseline (no reasoning): no thinking, no output_config; temperature and
    // topK present. topP is dropped even here — baseline adapter interplay
    // ("topP is not supported when temperature is set", fires with reasoning
    // off too).
    expect(off["thinking"]).toBeUndefined();
    expect(off["output_config"]).toBeUndefined();
    expect(off["temperature"]).toBe(0.9);
    expect(off["top_k"]).toBe(80);
    expect(off["top_p"]).toBeUndefined();
    expect(off["max_tokens"]).toBe(4096);
    // Effort envelope: adaptive thinking + output_config.effort (sonnet-4-6 is
    // adaptive-capable per the adapter's model capabilities).
    expect(canon(on["thinking"])).toBe(canon({ type: "adaptive", display: "summarized" }));
    expect(canon(on["output_config"])).toBe(canon({ effort: "high" }));
    // Documented provider-mandated interplay (Anthropic extended thinking):
    // temperature and topK are dropped when thinking is on; max_tokens is
    // unchanged on the adaptive path (no budget added). Together with the
    // envelope this is the COMPLETE set of reasoning-driven body changes.
    expect(on["temperature"]).toBeUndefined();
    expect(on["top_k"]).toBeUndefined();
    expect(on["max_tokens"]).toBe(4096);
    expect(changedKeys(on, off)).toEqual(["output_config", "temperature", "thinking", "top_k"]);
  });

  it("anthropic: providerOptions.anthropic.effort sends output_config.effort with NO thinking — sampling survives (VT's effort path since 2026-10-04)", async () => {
    const { bodies, fetch } = captureFetch(ANTHROPIC_RESPONSE);
    const anthropic = createAnthropic({ apiKey: "test-key", fetch });
    const base = {
      model: anthropic("claude-sonnet-4-6"),
      prompt: "Hi",
      temperature: 0.9,
      topK: 80,
      maxOutputTokens: 4096,
    };

    await generateText(base);
    await generateText({ ...base, providerOptions: { anthropic: { effort: "high" } } });

    expect(bodies).toHaveLength(2);
    const [off, on] = bodies;
    // The complete pin of the path sampler-mapper.ts now uses for
    // effort-capable families: ONLY output_config is added — no thinking
    // param, so temperature/topK stay (topP still loses to temperature by
    // the baseline interplay, effort or not).
    expect(on["output_config"]).toEqual({ effort: "high" });
    expect(on["thinking"]).toBeUndefined();
    expect(on["temperature"]).toBe(0.9);
    expect(on["top_k"]).toBe(80);
    expect(changedKeys(on, off)).toEqual(["output_config"]);
  });

  it("google (classic): reasoning adds ONLY generationConfig.thinkingConfig", async () => {
    const { bodies, fetch } = captureFetch(GOOGLE_RESPONSE);
    const google = createGoogle({ apiKey: "test-key", fetch });
    const base = {
      model: google("gemini-3-flash-preview"),
      prompt: "Hi",
      temperature: 0.9,
      topP: 0.95,
      maxOutputTokens: 4096,
    };

    await generateText(base);
    await generateText({ ...base, reasoning: "low" });

    expect(bodies).toHaveLength(2);
    const [off, on] = bodies;
    const offGen = off["generationConfig"] as Record<string, unknown>;
    const onGen = on["generationConfig"] as Record<string, unknown>;
    expect(offGen["thinkingConfig"]).toBeUndefined();
    expect(offGen["temperature"]).toBe(0.9);
    expect(offGen["topP"]).toBe(0.95);
    expect(offGen["maxOutputTokens"]).toBe(4096);
    // Gemini 3 expresses the effort as thinkingConfig.thinkingLevel.
    expect(canon(onGen["thinkingConfig"])).toBe(canon({ thinkingLevel: "low" }));
    // The pin: inside generationConfig nothing else differs; outside it
    // nothing differs at all.
    expect(changedKeys(onGen, offGen)).toEqual(["thinkingConfig"]);
    expect(changedKeys(on, off)).toEqual(["generationConfig"]);
  });

  it("google interactions: effort must ride providerOptions.google.thinkingLevel — the neutral reasoning setting is a no-op there", async () => {
    const { bodies, fetch } = captureFetch(INTERACTIONS_RESPONSE);
    const google = createGoogle({ apiKey: "test-key", fetch });
    const base = {
      model: google.interactions("gemini-3-flash-preview"),
      prompt: "Hi",
      temperature: 0.9,
      maxOutputTokens: 4096,
    };

    await generateText(base);
    await generateText({ ...base, reasoning: "low" });
    await generateText({
      ...base,
      providerOptions: { google: { thinkingLevel: "low" } },
    });

    expect(bodies).toHaveLength(3);
    const [off, neutralOn, providerOptionsOn] = bodies.map(
      (b) => b["generation_config"] as Record<string, unknown>,
    );
    // Baseline: no thinking_level, temperature present.
    expect(off["thinking_level"]).toBeUndefined();
    expect(off["temperature"]).toBe(0.9);
    // The no-op pin (installed @ai-sdk/google 4.0.69): GoogleInteractionsLanguageModel
    // never reads the neutral `reasoning` call setting — the body is unchanged.
    expect(changedKeys(neutralOn, off)).toEqual([]);
    // The documented surface for this model type: providerOptions.google.thinkingLevel
    // -> generation_config.thinking_level, and nothing else differs.
    expect(providerOptionsOn["thinking_level"]).toBe("low");
    expect(changedKeys(providerOptionsOn, off)).toEqual(["thinking_level"]);
  });
});
