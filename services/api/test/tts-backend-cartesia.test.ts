import { afterEach, describe, expect, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import { CartesiaTtsBackend, cartesiaTtsFactory, parseVoicesPage } from "../src/domain/tts/backends/cartesia-tts.js";
import { createTtsBackend } from "../src/domain/tts/tts-registry.js";

function backend(config: Record<string, unknown> = {}): CartesiaTtsBackend {
  return cartesiaTtsFactory({ apiKey: "sk_car_key", ...config }) as CartesiaTtsBackend;
}

// ─── fetch mock helpers (house pattern — see tts-backend-elevenlabs.test.ts) ─

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

// ─── generate (POST /tts/bytes) ──────────────────────────────────────────────

describe("CartesiaTtsBackend.generate", () => {
  test("sends the documented body shape with Bearer + Cartesia-Version headers", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    const result = await backend().generate({ text: "Hello there.", voiceId: "voice-abc" });

    const req = lastRequest();
    expect(req.url).toBe("https://api.cartesia.ai/tts/bytes");
    expect(req.init.method).toBe("POST");
    expect(req.headers.get("Authorization")).toBe("Bearer sk_car_key");
    // The only value documented on every endpoint reference page today
    // (the JS SDK already defaults newer — see the adapter's module doc).
    expect(req.headers.get("Cartesia-Version")).toBe("2026-03-01");
    expect(req.headers.get("Content-Type")).toBe("application/json");
    expect(req.body).toEqual({
      model_id: "sonic-3.5",
      transcript: "Hello there.",
      voice: { mode: "id", id: "voice-abc" },
      output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
    });
    expect(Buffer.from(await collectAudio(result.audio))).toEqual(Buffer.from([1, 2, 3]));
    expect(result.mime).toBe("audio/mpeg");
  });

  test("omits language when unset and passes it through when set", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend().generate({ text: "hi", voiceId: "v1" });
    expect((lastRequest().body as Record<string, unknown>).language).toBeUndefined();

    await backend({ language: "ru" }).generate({ text: "привет", voiceId: "v1" });
    expect((lastRequest().body as Record<string, unknown>).language).toBe("ru");
  });

  test("sends generation_config (speed + emotion) only for sonic-3-family models", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    // sonic-3.5: config rides along.
    await backend({ speed: 1.2, emotion: "curious" }).generate({ text: "hi", voiceId: "v1" });
    expect((lastRequest().body as Record<string, unknown>).generation_config).toEqual({
      speed: 1.2,
      emotion: "curious",
    });

    // sonic-latest: allowed too.
    await backend({ modelId: "sonic-latest", speed: 0.9, emotion: "angry" }).generate({ text: "hi", voiceId: "v1" });
    expect((lastRequest().body as Record<string, unknown>).generation_config).toEqual({
      speed: 0.9,
      emotion: "angry",
    });

    // sonic-2 / sonic-turbo: docs say generation_config is "not available on
    // earlier models" — the key must NOT ride along even when configured.
    await backend({ modelId: "sonic-2", speed: 1.2, emotion: "calm" }).generate({ text: "hi", voiceId: "v1" });
    expect((lastRequest().body as Record<string, unknown>).generation_config).toBeUndefined();

    await backend({ modelId: "sonic-turbo", speed: 1.2 }).generate({ text: "hi", voiceId: "v1" });
    expect((lastRequest().body as Record<string, unknown>).generation_config).toBeUndefined();
  });

  test("clamps a hand-edited out-of-range speed into the documented [0.6, 1.5]", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend({ speed: 4 }).generate({ text: "hi", voiceId: "v1" });
    expect((lastRequest().body as Record<string, unknown>).generation_config).toEqual({ speed: 1.5 });

    await backend({ speed: 0.1 }).generate({ text: "hi", voiceId: "v1" });
    expect((lastRequest().body as Record<string, unknown>).generation_config).toEqual({ speed: 0.6 });
  });

  test("includes a partial generation_config when only one knob is set", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend({ emotion: "flirtatious" }).generate({ text: "hi", voiceId: "v1" });
    expect((lastRequest().body as Record<string, unknown>).generation_config).toEqual({ emotion: "flirtatious" });
  });

  test("throws with an upstream excerpt on a non-2xx response", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ error: "insufficient credits" }), {
      status: 402,
      headers: { "content-type": "application/json" },
    });

    await expect(backend().generate({ text: "hi", voiceId: "v1" })).rejects.toThrow(
      /Cartesia text-to-speech failed with HTTP 402.*insufficient credits/,
    );
  });

  test("requires a non-empty apiKey and voiceId", async () => {
    installFetchMock();
    await expect(cartesiaTtsFactory({}).generate({ text: "hi", voiceId: "v1" })).rejects.toThrow(
      /requires a non-empty apiKey/,
    );
    await expect(backend().generate({ text: "hi", voiceId: "  " })).rejects.toThrow(/non-empty voiceId/);
    expect(recordedRequests.length).toBe(0);
  });
});

// ─── listVoices (GET /voices, cursor pagination) ─────────────────────────────

describe("CartesiaTtsBackend.listVoices", () => {
  test("follows has_more via starting_after and maps entries to TtsVoiceInfo", async () => {
    installFetchMock();
    let call = 0;
    nextResponse = () => {
      call++;
      if (call === 1) {
        return Response.json({
          data: [
            { id: "lib-1", name: "Katie", language: "en", is_owner: false, is_public: true },
            { id: "clone-1", name: "My Clone", language: "ru", is_owner: true, is_public: false },
            { id: "" }, // filtered by the parse guard
          ],
          has_more: true,
        });
      }
      return Response.json({ data: [{ id: "lib-2", name: "Jameson", language: "en" }], has_more: false });
    };

    const voices = await backend().listVoices();

    expect(voices).toEqual([
      { id: "lib-1", label: "Katie · en", lang: "en" },
      { id: "clone-1", label: "My Clone · ru · mine", lang: "ru" },
      { id: "lib-2", label: "Jameson · en", lang: "en" },
    ]);
    expect(recordedRequests.length).toBe(2);
    const firstUrl = new URL(recordedRequests[0]!.url);
    const secondUrl = new URL(recordedRequests[1]!.url);
    expect(firstUrl.pathname).toBe("/voices");
    expect(firstUrl.searchParams.get("limit")).toBe("100");
    expect(firstUrl.searchParams.get("starting_after")).toBeNull();
    expect(secondUrl.searchParams.get("starting_after")).toBe("clone-1");
    expect(recordedRequests[1]!.headers.get("Authorization")).toBe("Bearer sk_car_key");
  });

  test("stops at the page cap even if the cursor never ends", async () => {
    installFetchMock();
    nextResponse = () =>
      Response.json({ data: [{ id: `v-${Math.random()}`, name: "Loop" }], has_more: true });

    const voices = await backend().listVoices();

    // 10 pages × 1 voice — the cap prevents an infinite cursor walk.
    expect(voices.length).toBe(10);
    expect(recordedRequests.length).toBe(10);
  });

  test("throws on a malformed payload", async () => {
    installFetchMock();
    nextResponse = Response.json({ nope: true });
    await expect(backend().listVoices()).rejects.toThrow(/missing the 'data' array/);

    nextResponse = new Response("not json", { status: 200 });
    await expect(backend().listVoices()).rejects.toThrow();
  });
});

describe("parseVoicesPage", () => {
  test("guards the unknown boundary", () => {
    expect(() => parseVoicesPage(null)).toThrow(/non-object payload/);
    expect(() => parseVoicesPage({ data: "no" })).toThrow(/missing the 'data' array/);
    expect(parseVoicesPage({ data: [], has_more: false })).toEqual({ voices: [], hasMore: false });
    // has_more absent → treated as false (defensive stop).
    expect(parseVoicesPage({ data: [{ id: "a" }] }).hasMore).toBe(false);
  });
});

// ─── listModels (static documented catalog — no network) ─────────────────────

describe("CartesiaTtsBackend.listModels", () => {
  test("serves the static documented catalog without touching the network", async () => {
    installFetchMock();
    const models = await backend().listModels();
    expect(models.map((m) => m.id)).toEqual(["sonic-3.5", "sonic-3", "sonic-latest", "sonic-turbo", "sonic-2"]);
    expect(recordedRequests.length).toBe(0);
  });
});

// ─── probe (GET /voices?limit=1) ──────────────────────────────────────────────

describe("CartesiaTtsBackend.probe", () => {
  test("probes the cheapest authenticated call and reports ok", async () => {
    installFetchMock();
    nextResponse = Response.json({ data: [], has_more: false });

    const result = await backend().probe();

    expect(result.ok).toBe(true);
    const url = new URL(lastRequest().url);
    expect(url.pathname).toBe("/voices");
    expect(url.searchParams.get("limit")).toBe("1");
  });

  test("surfaces HTTP failures and missing keys without throwing", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ message: "invalid api key" }), { status: 401 });
    const failed = await backend().probe();
    expect(failed.ok).toBe(false);
    expect(failed.detail).toMatch(/401.*invalid api key/);

    const noKey = await cartesiaTtsFactory({}).probe();
    expect(noKey).toEqual({ ok: false, detail: "apiKey is required for Cartesia." });
  });
});

// ─── cloneVoice (POST /voices/clone multipart) ────────────────────────────────

describe("CartesiaTtsBackend.cloneVoice", () => {
  function cloneFormOf(req: RecordedRequest): FormData {
    expect(req.init.body).toBeInstanceOf(FormData);
    return req.init.body as FormData;
  }

  test("sends clip + name + language(access private) and maps the response", async () => {
    installFetchMock();
    nextResponse = Response.json({
      id: "clone-9",
      name: "Hero Voice",
      language: "en",
      is_public: false,
      created_at: "2026-01-01T00:00:00.000Z",
      user_id: "org_123",
    });

    const voice = await backend().cloneVoice({
      name: "Hero Voice",
      referenceAudio: Buffer.from([9, 9, 9]),
      mimeType: "audio/mpeg",
    });

    expect(voice).toEqual({ id: "clone-9", label: "Hero Voice · en · mine", lang: "en" });

    const req = lastRequest();
    expect(req.url).toBe("https://api.cartesia.ai/voices/clone");
    expect(req.init.method).toBe("POST");
    expect(req.headers.get("Authorization")).toBe("Bearer sk_car_key");
    expect(req.headers.get("Cartesia-Version")).toBe("2026-03-01");
    // No explicit Content-Type: the FormData boundary is set by fetch itself.
    expect(req.headers.get("Content-Type")).toBeNull();

    const form = cloneFormOf(req);
    // Language is REQUIRED by the clone endpoint — English-first fallback.
    expect(form.get("name")).toBe("Hero Voice");
    expect(form.get("language")).toBe("en");
    expect(form.get("access[type]")).toBe("private");
    const clip = form.get("clip");
    expect(clip).toBeInstanceOf(File);
    const file = clip as File;
    // Extension-keyed filename from the supported list, mime preserved.
    expect(file.name).toBe("clip.mp3");
    expect(file.type).toBe("audio/mpeg");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from([9, 9, 9]));
  });

  test("prefers config.language for the clone and derives filenames per mime", async () => {
    installFetchMock();
    nextResponse = Response.json({ id: "c1", name: "N", language: "ru" });

    await backend({ language: "ru" }).cloneVoice({
      name: "N",
      referenceAudio: Buffer.from([1]),
      mimeType: "audio/wav",
    });
    expect((lastRequest().init.body as FormData).get("language")).toBe("ru");
    expect(((lastRequest().init.body as FormData).get("clip") as File).name).toBe("clip.wav");

    await backend().cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/webm" });
    expect(((lastRequest().init.body as FormData).get("clip") as File).name).toBe("clip.webm");

    await backend().cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/ogg" });
    expect(((lastRequest().init.body as FormData).get("clip") as File).name).toBe("clip.ogg");

    await backend().cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/flac" });
    expect(((lastRequest().init.body as FormData).get("clip") as File).name).toBe("clip.flac");
  });

  test("throws with the upstream excerpt on failure", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ message: "clip too short" }), { status: 422 });

    await expect(
      backend().cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/mpeg" }),
    ).rejects.toThrow(/Cartesia voice clone failed with HTTP 422.*clip too short/);
  });
});

// ─── capabilities / registry wiring ───────────────────────────────────────────

describe("CartesiaTtsBackend.capabilities", () => {
  test("declares static cloning with the documented sample hints", () => {
    const caps = backend().capabilities();
    expect(caps.supportsCloning).toBe(true);
    expect(caps.formats).toEqual(["flac", "mp3", "wav", "ogg", "webm"]);
    expect(caps.maxSizeMb).toBe(10);
  });
});

describe("registry wiring (cartesia)", () => {
  test("module import registers the factory under the cartesia slug", () => {
    const created = createTtsBackend(TTS_BACKEND.Cartesia, { apiKey: "k" });
    expect(created).toBeInstanceOf(CartesiaTtsBackend);
    expect(created.capabilities().supportsCloning).toBe(true);
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

async function collectAudio(audio: Buffer | AsyncIterable<Buffer>): Promise<Uint8Array> {
  if (Buffer.isBuffer(audio)) return audio;
  const chunks: Buffer[] = [];
  for await (const chunk of audio) chunks.push(chunk);
  return Buffer.concat(chunks);
}
