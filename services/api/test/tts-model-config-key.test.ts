/**
 * TTS model config key (IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 11b).
 * Saved-profile voice lists are stored per model (`voices:<modelId>`); the
 * model id is read through `TTS_BACKEND_MODEL_CONFIG_KEY`, which must name the
 * SAME config field each backend's own config reader consumes. This file pins
 * that table against the real backends: a sentinel placed under the declared
 * key reaches the backend's synthesis request, and for the backends declared
 * model-less a sentinel under either name never does.
 *
 * Not pinned: kokoro (in-browser, no server factory) and google-cloud (its
 * synthesis path needs an OAuth token exchange; its config reader consumes
 * only the service-account `apiKey`).
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";
import type { TtsBackendSlug } from "@vibe-tavern/domain";

import type { TtsBackendFactory } from "../src/domain/tts/tts-backend.js";
import { TTS_BACKEND_MODEL_CONFIG_KEY, ttsConfigModelId } from "../src/domain/tts/tts-registry.js";
import { azureTtsFactory } from "../src/domain/tts/backends/azure-tts.js";
import { cartesiaTtsFactory } from "../src/domain/tts/backends/cartesia-tts.js";
import { deepgramTtsFactory } from "../src/domain/tts/backends/deepgram-tts.js";
import { elevenLabsTtsFactory } from "../src/domain/tts/backends/elevenlabs-tts.js";
import { geminiTtsFactory } from "../src/domain/tts/backends/gemini-tts.js";
import { inworldTtsFactory } from "../src/domain/tts/backends/inworld-tts.js";
import { lmntTtsFactory } from "../src/domain/tts/backends/lmnt-tts.js";
import { minimaxTtsFactory } from "../src/domain/tts/backends/minimax-tts.js";
import { mistralTtsFactory } from "../src/domain/tts/backends/mistral-tts.js";
import { openAiCompatTtsFactory } from "../src/domain/tts/backends/openai-tts.js";
import { pollyTtsFactory } from "../src/domain/tts/backends/polly-tts.js";
import { volcengineTtsFactory } from "../src/domain/tts/backends/volcengine-tts.js";
import { xaiTtsFactory } from "../src/domain/tts/backends/xai-tts.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

const SENTINEL = "pin-model-sentinel-7c1f";

/** The minimal config each backend needs to build and send a synthesis request. */
const BACKENDS: ReadonlyArray<{ slug: TtsBackendSlug; factory: TtsBackendFactory; base: Record<string, unknown> }> = [
  { slug: TTS_BACKEND.OpenAiCompatible, factory: openAiCompatTtsFactory, base: { endpoint: "http://localhost:8880/v1" } },
  { slug: TTS_BACKEND.Gemini, factory: geminiTtsFactory, base: { apiKey: "k" } },
  { slug: TTS_BACKEND.Mistral, factory: mistralTtsFactory, base: { apiKey: "k" } },
  { slug: TTS_BACKEND.ElevenLabs, factory: elevenLabsTtsFactory, base: { apiKey: "k" } },
  { slug: TTS_BACKEND.Cartesia, factory: cartesiaTtsFactory, base: { apiKey: "k" } },
  { slug: TTS_BACKEND.Inworld, factory: inworldTtsFactory, base: { apiKey: "k" } },
  { slug: TTS_BACKEND.Lmnt, factory: lmntTtsFactory, base: { apiKey: "k" } },
  { slug: TTS_BACKEND.MiniMax, factory: minimaxTtsFactory, base: { apiKey: "k" } },
  { slug: TTS_BACKEND.Volcengine, factory: volcengineTtsFactory, base: { apiKey: "k", appId: "app" } },
  { slug: TTS_BACKEND.Deepgram, factory: deepgramTtsFactory, base: { apiKey: "k" } },
  { slug: TTS_BACKEND.Xai, factory: xaiTtsFactory, base: { apiKey: "k" } },
  { slug: TTS_BACKEND.Azure, factory: azureTtsFactory, base: { apiKey: "k", region: "westus" } },
  { slug: TTS_BACKEND.Polly, factory: pollyTtsFactory, base: { apiKey: "k", accessKeyId: "id", region: "us-east-1" } },
];

/** Everything the backend sent upstream for one synthesis, as one string. */
async function synthesisRequestText(factory: TtsBackendFactory, config: Record<string, unknown>): Promise<string> {
  const sent: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init?.headers;
    sent.push(JSON.stringify({ url: String(input), headers, body: typeof init?.body === "string" ? init.body : null }));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const backend = factory(config);
  // The reply is garbage on purpose — only the request matters, so a parse
  // failure after the send is expected.
  await backend.generate({ text: "hello", voiceId: "voice-1" }).catch((error: unknown) => error);
  return sent.join("\n");
}

describe("TTS_BACKEND_MODEL_CONFIG_KEY — the declared field is the one each backend reads", () => {
  for (const { slug, factory, base } of BACKENDS) {
    const key = TTS_BACKEND_MODEL_CONFIG_KEY[slug];
    if (key !== null) {
      test(`${slug}: a model under "${key}" reaches the synthesis request`, async () => {
        const text = await synthesisRequestText(factory, { ...base, [key]: SENTINEL });
        expect(text).toContain(SENTINEL);
      });
      test(`${slug}: a model under the other field name ("${key === "model" ? "modelId" : "model"}") does not`, async () => {
        const other = key === "model" ? "modelId" : "model";
        const text = await synthesisRequestText(factory, { ...base, [other]: SENTINEL });
        expect(text).not.toContain(SENTINEL);
      });
    } else {
      test(`${slug}: declared model-less - a model under either name never reaches the request`, async () => {
        const text = await synthesisRequestText(factory, { ...base, model: SENTINEL, modelId: SENTINEL });
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toContain(SENTINEL);
      });
    }
  }
});

describe("ttsConfigModelId", () => {
  test("reads the backend's own key only", () => {
    expect(ttsConfigModelId("openai-compatible", { model: "m1", modelId: "ignored" })).toBe("m1");
    expect(ttsConfigModelId("inworld", { model: "ignored", modelId: "m2" })).toBe("m2");
  });

  test("a blank or missing model is the empty id; a model-less backend is always empty", () => {
    expect(ttsConfigModelId("openai-compatible", {})).toBe("");
    expect(ttsConfigModelId("openai-compatible", { model: "   " })).toBe("");
    expect(ttsConfigModelId("cartesia", { modelId: 7 })).toBe("");
    expect(ttsConfigModelId("polly", { model: "m", modelId: "m" })).toBe("");
    expect(ttsConfigModelId("kokoro", { model: "m" })).toBe("");
  });

  test("an unknown slug throws like the rest of the registry", () => {
    expect(() => ttsConfigModelId("nope", {})).toThrow();
  });
});
