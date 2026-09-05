/**
 * Transport-pin tests for the whisper.cpp STT adapter (SPE-9).
 *
 * Doc gate: ggml-org/whisper.cpp examples/server/server.cpp @ master
 * (read in full 2026-09-05): `POST {endpoint}/inference` multipart with the
 * `file` field + `response_format=json` → `{"text"}`; `GET /health` →
 * `{"status":"ok"}` / 503 `{"status":"loading model"}`; errors
 * `{"error": <message>}`; no auth of any kind.
 *
 * Every request below is pinned against `globalThis.fetch` — the wire
 * (URL, method, multipart fields, absence of auth headers) is the
 * contract, not the mock's shape.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { STT_BACKENDS } from "@vibe-tavern/domain";

import {
  WhisperCppSttConfigError,
  WhisperCppSttError,
  extractInferenceTranscript,
  whisperCppSttFactory,
} from "../src/domain/stt/backends/whisper-cpp-stt.js";
import {
  STT_BACKEND_CAPABILITIES,
  createSttBackend,
} from "../src/domain/stt/stt-registry.js";

/** Minimal Response shim (Bun on Windows may lack globals in test scope). */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;

const fetchMock = mock(() => Promise.resolve(jsonResponse(200, { text: "hi" })));

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

// Restore the REAL fetch after every test — this file shares one bun test
// process with the whole api suite, and a leaked fetch mock poisons every
// later network-dependent file (update-check et al. — the mock.module leak
// class applied to globals).
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeConfig(endpoint: string): Parameters<typeof whisperCppSttFactory>[0] {
  // Loose config bag with the ST-5a boundary cast (no `as any`).
  return { endpoint } as Parameters<typeof whisperCppSttFactory>[0];
}

describe("whisper.cpp STT adapter (SPE-9)", () => {
  test("factory exposes transcribe + probe, no listModels (probe fallback owns the Test button)", () => {
    // NOTE: no __resetSttRegistryForTests() here — resetting would clear
    // the module-scope registration for the ENTIRE bun test process
    // (the mock.module leak class); the direct factory call needs no
    // registry state, and the registry test below relies on the
    // import-time registration being intact.
    const backend = whisperCppSttFactory(makeConfig("http://127.0.0.1:8080"));
    expect(typeof backend.transcribe).toBe("function");
    expect(typeof backend.probe).toBe("function");
    expect(backend.listModels).toBeUndefined();
  });

  test("config error when endpoint is missing", () => {
    expect(() => whisperCppSttFactory(makeConfig(""))).toThrow(WhisperCppSttConfigError);
    expect(() => whisperCppSttFactory(makeConfig("   "))).toThrow(WhisperCppSttConfigError);
  });

  test("transcribe pins POST {endpoint}/inference multipart with the `file` field and response_format=json", async () => {
    const backend = whisperCppSttFactory(makeConfig("http://127.0.0.1:8080"));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { text: "привет мир" }));

    const result = await backend.transcribe(new Uint8Array([1, 2, 3]).buffer, {
      mime: "audio/webm",
    });

    expect(result.text).toBe("привет мир");
    expect(result.language).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/inference");
    expect(init.method).toBe("POST");
    // No auth of any kind — the server checks none.
    expect(init.headers).toBeUndefined();
    // Multipart body carries the documented field name and format.
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).type).toBe("audio/webm");
    expect(form.get("response_format")).toBe("json");
    // No per-request language without a hint (the server -l default rules).
    expect(form.get("language")).toBeNull();
    // No model field — the model is bound at server start.
    expect(form.get("model")).toBeNull();
  });

  test("transcribe passes the language hint as a multipart field when carried", async () => {
    const backend = whisperCppSttFactory(makeConfig("http://localhost:9000/"));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { text: "ok" }));

    await backend.transcribe(new Uint8Array([1]).buffer, {
      mime: "audio/webm",
      language: "ru",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const form = init.body as FormData;
    expect(form.get("language")).toBe("ru");
    // Trailing slashes on the endpoint are normalized away.
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:9000/inference");
  });

  test("transcribe maps a 400 no-file failure onto WhisperCppSttError with status + parsed error body", async () => {
    const backend = whisperCppSttFactory(makeConfig("http://127.0.0.1:8080"));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: "no 'file' field in the request" }),
    );

    let caught: unknown;
    try {
      await backend.transcribe(new Uint8Array([1]).buffer, { mime: "audio/webm" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WhisperCppSttError);
    const typed = caught as WhisperCppSttError;
    expect(typed.status).toBe(400);
    expect(typed.message).toContain("HTTP 400");
    expect(typed.message).toContain("no 'file' field in the request");
  });

  test("transcribe wraps transport failures (refused connection) in WhisperCppSttError", async () => {
    const backend = whisperCppSttFactory(makeConfig("http://127.0.0.1:8080"));
    fetchMock.mockRejectedValueOnce(new Error("Connection refused"));

    let caught: unknown;
    try {
      await backend.transcribe(new Uint8Array([1]).buffer, { mime: "audio/webm" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WhisperCppSttError);
    expect((caught as WhisperCppSttError).status).toBeUndefined();
    expect((caught as WhisperCppSttError).message).toContain("network error");
  });

  test("probe hits GET /health and goes green on {status:ok}", async () => {
    const backend = whisperCppSttFactory(makeConfig("http://127.0.0.1:8080"));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: "ok" }));

    const result = await backend.probe();

    expect(result.ok).toBe(true);
    expect(result.detail).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/health");
    expect(init.method).toBeUndefined(); // GET (fetch default)
  });

  test("probe reports 503 loading-model with its status (the model is still loading)", async () => {
    const backend = whisperCppSttFactory(makeConfig("http://127.0.0.1:8080"));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(503, { status: "loading model" }),
    );

    const result = await backend.probe();

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.detail).toContain("loading model");
  });

  test("probe reports a refused connection as a failure (server not running)", async () => {
    const backend = whisperCppSttFactory(makeConfig("http://127.0.0.1:8080"));
    fetchMock.mockRejectedValueOnce(new Error("Connection refused"));

    const result = await backend.probe();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Connection refused");
  });

  test("extractInferenceTranscript is defensive against non-{text} payloads", () => {
    expect(extractInferenceTranscript({ text: "hi" })).toBe("hi");
    expect(extractInferenceTranscript({})).toBe("");
    expect(extractInferenceTranscript(null)).toBe("");
    expect(extractInferenceTranscript("text")).toBe("");
    expect(extractInferenceTranscript({ text: 42 })).toBe("");
  });

  test("capabilities: keyless server transport, not OpenAI-compatible, no streaming, no emotion", () => {
    const caps = STT_BACKEND_CAPABILITIES[STT_BACKENDS.WhisperCpp];
    expect(caps.transport).toBe("server");
    expect(caps.openaiCompatible).toBe(false);
    expect(caps.supportsStreaming).toBe(false);
    expect(caps.emotionAnnotation).toBe(false);
    expect(caps.requiresApiKey).toBe(false);
  });

  test("createSttBackend resolves the whisper-cpp factory via the registry", () => {
    // The module-scope registration ran at import time (this file imports
    // the adapter module) — createSttBackend must find it.
    const backend = createSttBackend("whisper-cpp", makeConfig("http://127.0.0.1:8080"));
    expect(typeof backend.transcribe).toBe("function");
  });
});
