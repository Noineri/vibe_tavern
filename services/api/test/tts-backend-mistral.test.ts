import { afterEach, describe, expect, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import { MistralTtsBackend, mistralTtsFactory } from "../src/domain/tts/backends/mistral-tts.js";
import { createTtsBackend } from "../src/domain/tts/tts-registry.js";

function backend(config: Record<string, unknown> = {}): MistralTtsBackend {
  return mistralTtsFactory({ apiKey: "mistral_key", ...config }) as MistralTtsBackend;
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

/** Non-stream speech response: { audio_data: base64 }. */
function speechResponse(): Response {
  return Response.json({ audio_data: Buffer.from([4, 5, 6]).toString("base64") });
}

// ─── generate (POST /v1/audio/speech) ────────────────────────────────────────

describe("MistralTtsBackend.generate", () => {
  test("sends the documented snake_case body (input/model/voice_id/response_format) and decodes base64 audio", async () => {
    installFetchMock();
    nextResponse = speechResponse();

    const result = await backend().generate({ text: "Hello there.", voiceId: "gb_jane_neutral" });

    const req = lastRequest();
    expect(req.url).toBe("https://api.mistral.ai/v1/audio/speech");
    expect(req.init.method).toBe("POST");
    expect(req.headers.get("Authorization")).toBe("Bearer mistral_key");
    expect(req.headers.get("Content-Type")).toBe("application/json");
    expect(req.body).toEqual({
      input: "Hello there.",
      model: "voxtral-mini-tts-2603",
      voice_id: "gb_jane_neutral",
      response_format: "mp3",
    });
    // No stream key — buffered contract; no speed knob exists on this wire.
    expect((req.body as Record<string, unknown>).stream).toBeUndefined();
    expect(Buffer.from(await collectAudio(result.audio))).toEqual(Buffer.from([4, 5, 6]));
    expect(result.mime).toBe("audio/mpeg");
  });

  test("passes configured model and response_format through; out-of-enum formats fall back to mp3", async () => {
    installFetchMock();
    nextResponse = speechResponse();

    await backend({ model: "voxtral-mini-tts-2603-x", responseFormat: "wav" }).generate({ text: "hi", voiceId: "v1" });
    expect(lastRequest().body).toEqual({
      input: "hi",
      model: "voxtral-mini-tts-2603-x",
      voice_id: "v1",
      response_format: "wav",
    });

    // A hand-edited profile must never send out-of-enum values.
    await backend({ responseFormat: "ulaw" }).generate({ text: "hi", voiceId: "v1" });
    expect((lastRequest().body as Record<string, unknown>).response_format).toBe("mp3");
  });

  test("mime follows the response format (wav/flac/opus)", async () => {
    installFetchMock();
    nextResponse = speechResponse();

    await backend({ responseFormat: "wav" }).generate({ text: "hi", voiceId: "v1" });
    const wav = await backend({ responseFormat: "wav" }).generate({ text: "hi", voiceId: "v1" });
    expect(wav.mime).toBe("audio/wav");

    const flac = await backend({ responseFormat: "flac" }).generate({ text: "hi", voiceId: "v1" });
    expect(flac.mime).toBe("audio/flac");

    const opus = await backend({ responseFormat: "opus" }).generate({ text: "hi", voiceId: "v1" });
    expect(opus.mime).toBe("audio/ogg");
  });

  test("throws with an upstream excerpt on a non-2xx response (moderation 403 ladder)", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ message: "content moderation violation" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });

    await expect(backend().generate({ text: "hi", voiceId: "v1" })).rejects.toThrow(
      /Mistral text-to-speech failed with HTTP 403.*content moderation violation/,
    );
  });

  test("rejects a malformed speech response (missing audio_data)", async () => {
    installFetchMock();
    nextResponse = () => Response.json({ unexpected: true });
    await expect(backend().generate({ text: "hi", voiceId: "v1" })).rejects.toThrow(/audio_data/);

    nextResponse = () => Response.json(null);
    await expect(backend().generate({ text: "hi", voiceId: "v1" })).rejects.toThrow(/not an object/);
  });

  test("requires a non-empty apiKey and voiceId", async () => {
    installFetchMock();
    await expect(mistralTtsFactory({}).generate({ text: "hi", voiceId: "v1" })).rejects.toThrow(
      /requires a non-empty apiKey/,
    );
    await expect(backend().generate({ text: "hi", voiceId: "  " })).rejects.toThrow(/non-empty voiceId/);
    expect(recordedRequests.length).toBe(0);
  });
});

// ─── listVoices (GET /v1/audio/voices?limit&offset&type=all) ─────────────────

describe("MistralTtsBackend.listVoices", () => {
  test("maps presets to slug identity with emotion-suffix labels; customs to slug ?? UUID + mine marker", async () => {
    installFetchMock();
    nextResponse = () =>
      Response.json({
        items: [
          // Preset: slug is the voice_id (cookbook), user_id null.
          { name: "Jane", slug: "gb_jane_neutral", languages: ["en"], id: "uuid-1", user_id: null },
          // Preset without a slug: UUID identity fallback.
          { name: "Legacy", id: "uuid-2", user_id: null },
          // Custom (cloned): user_id set, no slug → UUID identity + mine.
          { name: "My Clone", id: "uuid-3", user_id: "user-9" },
        ],
        total: 3,
        page: 1,
        page_size: 100,
        total_pages: 1,
      });

    const voices = await backend().listVoices();

    expect(voices).toEqual([
      { id: "gb_jane_neutral", label: "Jane · gb_jane_neutral", lang: "en" },
      { id: "uuid-2", label: "Legacy", lang: "multi" },
      { id: "uuid-3", label: "My Clone · mine", lang: "multi" },
    ]);

    const req = recordedRequests[0]!;
    expect(req.url).toBe("https://api.mistral.ai/v1/audio/voices?limit=100&offset=0&type=all");
    expect(req.headers.get("Authorization")).toBe("Bearer mistral_key");
  });

  test("follows offset pagination until the total is covered", async () => {
    installFetchMock();
    let call = 0;
    nextResponse = () => {
      call++;
      if (call === 1) {
        return Response.json({
          items: [
            { name: "A", slug: "a_neutral", id: "u1", user_id: null },
            { name: "B", slug: "b_sad", id: "u2", user_id: null },
          ],
          total: 3,
          page: 1,
          page_size: 2,
          total_pages: 2,
        });
      }
      return Response.json({
        items: [{ name: "C", slug: "c_happy", id: "u3", user_id: null }],
        total: 3,
        page: 2,
        page_size: 2,
        total_pages: 2,
      });
    };

    const voices = await backend().listVoices();

    expect(voices.map((v) => v.id)).toEqual(["a_neutral", "b_sad", "c_happy"]);
    expect(recordedRequests[0]!.url).toContain("offset=0");
    expect(recordedRequests[1]!.url).toContain("offset=100");
    expect(recordedRequests.length).toBe(2);
  });

  test("rejects malformed list payloads (missing items / non-object)", async () => {
    installFetchMock();
    nextResponse = () => Response.json({ no_items: [] });
    await expect(backend().listVoices()).rejects.toThrow(/missing the 'items' array/);

    nextResponse = () => Response.json({ items: [], total: "many" });
    await expect(backend().listVoices()).rejects.toThrow(/missing the 'total' number/);

    nextResponse = () => Response.json(null);
    await expect(backend().listVoices()).rejects.toThrow(/non-object payload/);
  });
});

// ─── cloneVoice (POST /v1/audio/voices) ──────────────────────────────────────

describe("MistralTtsBackend.cloneVoice", () => {
  test("sends name + base64 sample_audio + sample_filename and maps the created voice", async () => {
    installFetchMock();
    nextResponse = () =>
      Response.json({ name: "My Voice", slug: "my_voice", id: "uuid-9", user_id: "user-9", created_at: "2026-09-10" });

    const sample = Buffer.from([9, 9, 9]);
    const created = await backend().cloneVoice({ name: "My Voice", referenceAudio: sample, mimeType: "audio/wav" });

    const req = lastRequest();
    expect(req.url).toBe("https://api.mistral.ai/v1/audio/voices");
    expect(req.init.method).toBe("POST");
    expect(req.headers.get("Authorization")).toBe("Bearer mistral_key");
    expect(req.body).toEqual({
      name: "My Voice",
      sample_audio: sample.toString("base64"),
      // Extension detection rides the mime-derived filename.
      sample_filename: "sample.wav",
    });
    expect(created).toEqual({ id: "my_voice", label: "My Voice · my_voice · mine", lang: "multi" });
  });

  test("derives sample_filename from the mime type", async () => {
    installFetchMock();
    nextResponse = () => Response.json({ name: "V", id: "uuid-10", user_id: "u", created_at: "2026-09-10" });

    await backend().cloneVoice({ name: "V", referenceAudio: Buffer.from([1]), mimeType: "audio/mpeg" });
    expect((lastRequest().body as Record<string, unknown>).sample_filename).toBe("sample.mp3");

    await backend().cloneVoice({ name: "V", referenceAudio: Buffer.from([1]), mimeType: "audio/webm" });
    expect((lastRequest().body as Record<string, unknown>).sample_filename).toBe("sample.webm");

    await backend().cloneVoice({ name: "V", referenceAudio: Buffer.from([1]), mimeType: "audio/flac" });
    expect((lastRequest().body as Record<string, unknown>).sample_filename).toBe("sample.flac");
  });

  test("throws with the upstream excerpt on a non-2xx clone response", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ detail: "sample too short" }), {
      status: 422,
      headers: { "content-type": "application/json" },
    });

    await expect(
      backend().cloneVoice({ name: "V", referenceAudio: Buffer.from([1]), mimeType: "audio/wav" }),
    ).rejects.toThrow(/Mistral voice clone failed with HTTP 422.*sample too short/);
  });

  test("requires a non-empty name and reference audio", async () => {
    installFetchMock();
    await expect(
      backend().cloneVoice({ name: "  ", referenceAudio: Buffer.from([1]), mimeType: "audio/wav" }),
    ).rejects.toThrow(/non-empty name/);
    await expect(
      backend().cloneVoice({ name: "V", referenceAudio: Buffer.alloc(0), mimeType: "audio/wav" }),
    ).rejects.toThrow(/non-empty reference audio/);
    expect(recordedRequests.length).toBe(0);
  });
});

// ─── probe (GET /v1/audio/voices?limit=1) ────────────────────────────────────

describe("MistralTtsBackend.probe", () => {
  test("probes the cheapest authenticated call and reports ok", async () => {
    installFetchMock();
    nextResponse = () => Response.json({ items: [], total: 0, page: 1, page_size: 1, total_pages: 0 });

    const result = await backend().probe();

    expect(result.ok).toBe(true);
    expect(result.detail).toBe("voices endpoint reachable");
    expect(lastRequest().url).toBe("https://api.mistral.ai/v1/audio/voices?limit=1");
    expect(lastRequest().headers.get("Authorization")).toBe("Bearer mistral_key");
  });

  test("reports a non-2xx status with its body detail", async () => {
    installFetchMock();
    nextResponse = () =>
      new Response(JSON.stringify({ message: "invalid key" }), { status: 401, headers: { "content-type": "application/json" } });

    const failed = await backend().probe();

    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain("401");
    expect(failed.detail).toContain("invalid key");
  });

  test("requires an apiKey and surfaces transport errors without throwing", async () => {
    const noKey = await mistralTtsFactory({}).probe();
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

describe("MistralTtsBackend capabilities & registry", () => {
  test("cloning is open (POST /v1/audio/voices) — the first wave-D native WITH a clone section", async () => {
    expect(backend().capabilities()).toEqual({ supportsCloning: true });
    expect(typeof backend().cloneVoice).toBe("function");
  });

  test("the module self-registers the 'mistral' slug in the protocol registry", async () => {
    const created = createTtsBackend(TTS_BACKEND.Mistral, { apiKey: "k" });
    expect(created).toBeInstanceOf(MistralTtsBackend);
    expect(created.capabilities().supportsCloning).toBe(true);
  });
});

async function collectAudio(audio: Buffer | AsyncIterable<Buffer>): Promise<Uint8Array> {
  if (Buffer.isBuffer(audio)) return audio;
  const chunks: Buffer[] = [];
  for await (const chunk of audio) chunks.push(chunk);
  return Buffer.concat(chunks);
}
