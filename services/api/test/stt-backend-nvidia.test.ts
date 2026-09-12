/**
 * NVIDIA hosted omni STT backend tests (STT_PROVIDER_EXPANSION SPE-6) —
 * mirror of stt-backend-gemini.test.ts (the same chat-audio pattern):
 * globalThis.fetch stub capturing the request, pinning the chat-completions
 * request shape (Bearer nvapi auth, audio_url data-URI content part, the
 * reference's decoding set — max_tokens/temperature/top_k/
 * chat_template_kwargs.enable_thinking) and the choices[0].message.content
 * extraction (with the defensive </think> strip). Pure-transport pins — no
 * live calls.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { DEFAULT_NVIDIA_STT_MODEL, STT_BACKENDS } from "@vibe-tavern/domain";

import {
  NvidiaSttConfigError,
  NvidiaSttError,
  extractChatTranscript,
  nvidiaSttFactory,
} from "../src/domain/stt/backends/nvidia-stt.js";
import type { SttBackend } from "../src/domain/stt/stt-backend.js";

const CHAT_COMPLETIONS_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODELS_URL = "https://integrate.api.nvidia.com/v1/models";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchArgs = Parameters<typeof fetch>;

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function captureFetch(handler: () => Response): { captured: () => CapturedRequest | null } {
  let captured: CapturedRequest | null = null;
  globalThis.fetch = mock(async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    const text = typeof init?.body === "string" ? init.body : "";
    captured = {
      url: String(input),
      init: init ?? {},
      body: text !== "" ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
    return handler();
  });
  return { captured: () => captured };
}

/** The chat-completions reply shape the transcript rides. */
function chatReply(content: string): unknown {
  return { choices: [{ message: { role: "assistant", content } }] };
}

const AUDIO_BYTES = Buffer.from("fake-wav-bytes-16k-mono");

function makeBackend(overrides: Record<string, unknown> = {}): SttBackend {
  return nvidiaSttFactory({
    model: "nvidia/omni-test",
    ...overrides,
  } as never);
}

describe("nvidia-stt: config", () => {
  test("missing apiKey → NvidiaSttConfigError", () => {
    expect(() => nvidiaSttFactory({ model: "m" } as never)).toThrow(NvidiaSttConfigError);
  });

  test("empty model falls back to DEFAULT_NVIDIA_STT_MODEL", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, chatReply("hi")));
    const backend = makeBackend({ apiKey: "k", model: "" });
    await backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" });
    expect(captured()!.body.model).toBe(DEFAULT_NVIDIA_STT_MODEL);
  });
});

describe("nvidia-stt: transcribe", () => {
  test("request shape: chat-completions URL, Bearer auth, audio_url data-URI part + instruction, reference decoding set", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, chatReply("hello there")));
    const backend = makeBackend({ apiKey: "nvapi-test-key" });

    const result = await backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" });

    const req = captured()!;
    expect(req.url).toBe(CHAT_COMPLETIONS_URL);
    // The key travels as a standard Bearer (nvapi-… key).
    expect((req.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer nvapi-test-key");

    const messages = req.body.messages as Array<Record<string, unknown>>;
    expect(Array.isArray(messages)).toBe(true);
    const content = messages[0].content as Array<Record<string, unknown>>;
    const audioPart = content.find((p) => p.type === "audio_url") as {
      audio_url: { url: string };
    };
    // The audio rides the data-URI form of audio_url (the reference's
    // file:// URI is an OpenAI-SDK client convention).
    expect(audioPart.audio_url.url).toBe(
      `data:audio/wav;base64,${AUDIO_BYTES.toString("base64")}`,
    );
    const textPart = content.find((p) => p.type === "text");
    expect(textPart?.text).toBe("Transcribe this audio.");

    // The reference example's decoding set — enable_thinking false keeps
    // the omni hybrid's reply a bare transcript.
    expect(req.body.max_tokens).toBe(1024);
    expect(req.body.temperature).toBe(1.0);
    expect(req.body.top_k).toBe(1);
    expect((req.body.chat_template_kwargs as Record<string, unknown>)["enable_thinking"]).toBe(false);

    expect(result.text).toBe("hello there");
    expect(result.annotation).toBeUndefined();
  });

  test("mime params are stripped from the data URI prefix", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, chatReply("hi")));
    const backend = makeBackend({ apiKey: "k" });
    await backend.transcribe(AUDIO_BYTES, { mime: "audio/wav;codecs=1" });
    const messages = captured()!.body.messages as Array<Record<string, unknown>>;
    const content = messages[0].content as Array<Record<string, unknown>>;
    const audioPart = content.find((p) => p.type === "audio_url") as {
      audio_url: { url: string };
    };
    expect(audioPart.audio_url.url.startsWith("data:audio/wav;base64,")).toBe(true);
  });
});

describe("nvidia-stt: errors", () => {
  test("HTTP failure with error.message → NvidiaSttError carrying it", async () => {
    captureFetch(() =>
      jsonResponse(401, { error: { message: "Invalid API key", type: "auth" } }),
    );
    const backend = makeBackend({ apiKey: "bad" });
    let caught: unknown;
    try {
      await backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" });
      expect.unreachable();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NvidiaSttError);
    const typed = caught as NvidiaSttError;
    expect(typed.status).toBe(401);
    expect(typed.message).toContain("Invalid API key");
  });

  test("transport failure → NvidiaSttError (network error wrapper)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const backend = makeBackend({ apiKey: "k" });
    await expect(backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" })).rejects.toMatchObject({
      name: "NvidiaSttError",
    });
  });
});

describe("nvidia-stt: probe", () => {
  test("GET /v1/models with Bearer; counts the chat catalog", async () => {
    const { captured } = captureFetch(() =>
      jsonResponse(200, { data: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
    );
    const backend = makeBackend({ apiKey: "k" });
    const result = await backend.probe();
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("3 models (catalog ok)");
    expect(captured()!.url).toBe(MODELS_URL);
    expect((captured()!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
  });

  test("HTTP failure → ok:false with the status", async () => {
    captureFetch(() => jsonResponse(401, { error: { message: "bad key" } }));
    const backend = makeBackend({ apiKey: "bad" });
    const result = await backend.probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("401");
  });
});

describe("nvidia-stt: extractChatTranscript (defensive containers)", () => {
  test("choices[0].message.content", () => {
    expect(extractChatTranscript(chatReply("from content"))).toBe("from content");
  });

  test("a reasoning block that slips through is stripped after </think>", () => {
    expect(extractChatTranscript(chatReply("<think>musing…</think>the transcript"))).toBe(
      "the transcript",
    );
  });

  test("missing containers → empty string, never a throw", () => {
    expect(extractChatTranscript(null)).toBe("");
    expect(extractChatTranscript({})).toBe("");
    expect(extractChatTranscript({ choices: [] })).toBe("");
    expect(extractChatTranscript({ choices: [{ message: {} }] })).toBe("");
    expect(extractChatTranscript({ choices: [{ message: { content: 42 } }] })).toBe("");
  });
});

describe("nvidia-stt: no listModels (static omni roster)", () => {
  test("listModels is deliberately absent — the chat catalog does not mark audio capability", async () => {
    const backend = makeBackend({ apiKey: "k" });
    expect(backend.listModels).toBeUndefined();
  });
});

describe("nvidia-stt: registry slug", () => {
  test("module-scope registration binds the nvidia slug", async () => {
    const { createSttBackend } = await import("../src/domain/stt/stt-registry.js");
    const backend = createSttBackend(STT_BACKENDS.Nvidia, { apiKey: "k" } as never);
    expect(typeof backend.transcribe).toBe("function");
  });
});
