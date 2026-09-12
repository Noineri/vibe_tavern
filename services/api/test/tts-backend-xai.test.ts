import { afterEach, describe, expect, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import { XaiTtsBackend, xaiTtsFactory, parseVoiceRoster } from "../src/domain/tts/backends/xai-tts.js";
import { createTtsBackend } from "../src/domain/tts/tts-registry.js";

function backend(config: Record<string, unknown> = {}): XaiTtsBackend {
  return xaiTtsFactory({ apiKey: "xai_key", ...config }) as XaiTtsBackend;
}

// ─── fetch mock helpers (house pattern — see tts-backend-cartesia.test.ts) ─

interface RecordedRequest {
  url: string;
  init: RequestInit;
  body: unknown;
  headers: Headers;
}

let recordedRequests: RecordedRequest[] = [];
let nextResponse: Response | (() => Response) = new Response("{}", { status: 200 });

// Snapshot BEFORE any mock is installed: restoring via the bare `fetch`
// identifier would read the CURRENT (mocked) global and no-op, leaking the
// mock into later files in this process.
const originalFetch = globalThis.fetch;

function installFetchMock(): void {
  recordedRequests = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    recordedRequests.push({ url, init: init ?? {}, body, headers });
    const response = typeof nextResponse === "function" ? nextResponse() : nextResponse;
    return response.clone();
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  recordedRequests = [];
  nextResponse = new Response("{}", { status: 200 });
});

function lastRequest(): RecordedRequest {
  expect(recordedRequests.length).toBeGreaterThan(0);
  return recordedRequests[recordedRequests.length - 1]!;
}

function audioResponse(bytes: Uint8Array = new Uint8Array([1, 2, 3])): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": "audio/mpeg" },
  });
}

// ─── generate (POST /v1/tts) ─────────────────────────────────────────────────

describe("XaiTtsBackend.generate", () => {
  test("sends the documented body shape with Bearer auth (language required, defaults to auto)", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    const result = await backend().generate({ text: "Hello there.", voiceId: "voice-abc" });

    const req = lastRequest();
    expect(req.url).toBe("https://api.x.ai/v1/tts");
    expect(req.init.method).toBe("POST");
    expect(req.headers.get("Authorization")).toBe("Bearer xai_key");
    expect(req.headers.get("Content-Type")).toBe("application/json");
    expect(req.body).toEqual({
      text: "Hello there.",
      voice_id: "voice-abc",
      // language is REQUIRED by the wire — unset profile → "auto".
      language: "auto",
      // The documented default output shape, pinned explicitly.
      output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 128000 },
    });
    // No speed key at the default — the API treats 1 as the default.
    expect((req.body as Record<string, unknown>).speed).toBeUndefined();
    expect(Buffer.from(await collectAudio(result.audio))).toEqual(Buffer.from([1, 2, 3]));
    expect(result.mime).toBe("audio/mpeg");
  });

  test("passes configured language and speed through, clamping speed into [0.7, 1.5]", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend({ language: "ru", speed: 1.2 }).generate({ text: "привет", voiceId: "v1" });
    expect(lastRequest().body).toEqual({
      text: "привет",
      voice_id: "v1",
      language: "ru",
      output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 128000 },
      speed: 1.2,
    });

    // Hand-edited profile values must never leave the documented range.
    await backend({ speed: 9 }).generate({ text: "hi", voiceId: "v1" });
    expect((lastRequest().body as Record<string, unknown>).speed).toBe(1.5);
    await backend({ speed: 0.1 }).generate({ text: "hi", voiceId: "v1" });
    expect((lastRequest().body as Record<string, unknown>).speed).toBe(0.7);
  });

  test("throws with an upstream excerpt on a non-2xx response", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ error: "insufficient credits" }), {
      status: 402,
      headers: { "content-type": "application/json" },
    });

    await expect(backend().generate({ text: "hi", voiceId: "v1" })).rejects.toThrow(
      /xAI text-to-speech failed with HTTP 402.*insufficient credits/,
    );
  });

  test("requires a non-empty apiKey and voiceId", async () => {
    installFetchMock();
    await expect(xaiTtsFactory({}).generate({ text: "hi", voiceId: "v1" })).rejects.toThrow(
      /requires a non-empty apiKey/,
    );
    await expect(backend().generate({ text: "hi", voiceId: "  " })).rejects.toThrow(/non-empty voiceId/);
    expect(recordedRequests.length).toBe(0);
  });
});

// ─── listVoices (GET /v1/tts/voices + GET /v1/custom-voices) ─────────────────

describe("XaiTtsBackend.listVoices", () => {
  test("merges the built-in roster with team custom voices (mine marker)", async () => {
    installFetchMock();
    let call = 0;
    nextResponse = () => {
      call++;
      if (call === 1) {
        // Built-in roster — custom voices never appear here.
        return Response.json({
          voices: [
            { voice_id: "eve", name: "Eve" },
            { voice_id: "brian", name: "Brian" },
            { no_id: true }, // filtered by the parse guard
          ],
        });
      }
      return Response.json({
        voices: [{ voice_id: "cust-1", name: "My Custom" }],
      });
    };

    const voices = await backend().listVoices();

    expect(voices).toEqual([
      { id: "eve", label: "Eve", lang: "multi" },
      { id: "brian", label: "Brian", lang: "multi" },
      { id: "cust-1", label: "My Custom · mine", lang: "multi" },
    ]);

    expect(recordedRequests[0]!.url).toBe("https://api.x.ai/v1/tts/voices");
    expect(recordedRequests[0]!.init.method).toBeUndefined();
    expect(recordedRequests[0]!.headers.get("Authorization")).toBe("Bearer xai_key");
    expect(recordedRequests[1]!.url).toBe("https://api.x.ai/v1/custom-voices?limit=100");
  });

  test("follows custom-voices pagination_token until the last page", async () => {
    installFetchMock();
    let call = 0;
    nextResponse = () => {
      call++;
      if (call === 1) return Response.json({ voices: [{ voice_id: "eve", name: "Eve" }] });
      if (call === 2) {
        return Response.json({
          voices: [{ voice_id: "c1", name: "One" }],
          pagination_token: "tok-2",
        });
      }
      if (call === 3) {
        return Response.json({
          voices: [{ voice_id: "c2", name: "Two" }],
          pagination_token: "tok-3",
        });
      }
      return Response.json({ voices: [] });
    };

    const voices = await backend().listVoices();

    expect(voices.map((v) => v.id)).toEqual(["eve", "c1", "c2"]);
    expect(recordedRequests[2]!.url).toBe("https://api.x.ai/v1/custom-voices?limit=100&pagination_token=tok-2");
    expect(recordedRequests[3]!.url).toBe("https://api.x.ai/v1/custom-voices?limit=100&pagination_token=tok-3");
    // Empty page stops the loop — no fifth request.
    expect(recordedRequests.length).toBe(4);
  });

  test("a 403 on custom-voices keeps the built-in roster (no custom access)", async () => {
    installFetchMock();
    let call = 0;
    nextResponse = () => {
      call++;
      if (call === 1) return Response.json({ voices: [{ voice_id: "eve", name: "Eve" }] });
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    };

    const voices = await backend().listVoices();

    expect(voices).toEqual([{ id: "eve", label: "Eve", lang: "multi" }]);
    expect(recordedRequests.length).toBe(2);
  });

  test("rejects malformed voice payloads (missing voices array / non-object)", async () => {
    installFetchMock();
    nextResponse = () => Response.json({ not_voices: [] });
    await expect(backend().listVoices()).rejects.toThrow(/missing the 'voices' array/);

    nextResponse = () => Response.json(null);
    await expect(backend().listVoices()).rejects.toThrow(/non-object payload/);
  });
});

// ─── probe (GET /v1/tts/voices) ──────────────────────────────────────────────

describe("XaiTtsBackend.probe", () => {
  test("probes the cheapest authenticated call and reports ok", async () => {
    installFetchMock();
    nextResponse = () => Response.json({ voices: [] });

    const result = await backend().probe();

    expect(result.ok).toBe(true);
    expect(result.detail).toBe("voices endpoint reachable");
    expect(lastRequest().url).toBe("https://api.x.ai/v1/tts/voices");
    expect(lastRequest().headers.get("Authorization")).toBe("Bearer xai_key");
  });

  test("reports a non-2xx status with its body detail", async () => {
    installFetchMock();
    nextResponse = () =>
      new Response(JSON.stringify({ error: "bad key" }), { status: 401, headers: { "content-type": "application/json" } });

    const failed = await backend().probe();

    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain("401");
    expect(failed.detail).toContain("bad key");
  });

  test("requires an apiKey and surfaces transport errors without throwing", async () => {
    const noKey = await xaiTtsFactory({}).probe();
    expect(noKey.ok).toBe(false);
    expect(noKey.detail).toContain("apiKey");

    installFetchMock();
    nextResponse = () => {
      throw new Error("socket hang up");
    };
    const thrown = await backend().probe();
    expect(thrown.ok).toBe(false);
    expect(thrown.detail).toContain("socket hang up");
  });
});

// ─── capabilities + registry ─────────────────────────────────────────────────

describe("XaiTtsBackend capabilities & registry", () => {
  test("cloning is off — the Custom Voices API is Enterprise-gated + US-only (docs ruling)", async () => {
    expect(backend().capabilities()).toEqual({ supportsCloning: false });
    expect(backend().cloneVoice).toBeUndefined();
  });

  test("the module self-registers the 'xai' slug in the protocol registry", async () => {
    const created = createTtsBackend(TTS_BACKEND.Xai, { apiKey: "k" });
    expect(created).toBeInstanceOf(XaiTtsBackend);
    expect(created.capabilities().supportsCloning).toBe(false);
  });
});

// ─── parseVoiceRoster (unit edge cases at the unknown edge) ──────────────────

describe("parseVoiceRoster", () => {
  test("maps entries and filters invalid ones, marking customs", () => {
    const voices = parseVoiceRoster(
      { voices: [{ voice_id: "a", name: "Alpha" }, { voice_id: "" }, { voice_id: "b" }, "junk"] },
      "custom",
    );
    expect(voices).toEqual([
      { id: "a", label: "Alpha · mine", lang: "multi" },
      { id: "b", label: "b · mine", lang: "multi" },
    ]);
  });
});

async function collectAudio(audio: Buffer | AsyncIterable<Buffer>): Promise<Uint8Array> {
  if (Buffer.isBuffer(audio)) return audio;
  const chunks: Buffer[] = [];
  for await (const chunk of audio) chunks.push(chunk);
  return Buffer.concat(chunks);
}
