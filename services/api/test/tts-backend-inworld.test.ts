import { afterEach, describe, expect, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import { InworldTtsBackend, inworldTtsFactory, parseVoicesPage } from "../src/domain/tts/backends/inworld-tts.js";
import { createTtsBackend } from "../src/domain/tts/tts-registry.js";

function backend(config: Record<string, unknown> = {}): InworldTtsBackend {
  return inworldTtsFactory({ apiKey: "inworld_key", ...config }) as InworldTtsBackend;
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

// The response is JSON with base64 audioContent — NOT raw bytes.
function synthesisResponse(bytes: Uint8Array = new Uint8Array([1, 2, 3])): Response {
  return Response.json({
    audioContent: Buffer.from(bytes).toString("base64"),
    usage: { processedCharactersCount: 6, modelId: "inworld-tts-2" },
  });
}

// ─── generate (POST /tts/v1/voice) ───────────────────────────────────────────

describe("InworldTtsBackend.generate", () => {
  test("sends the documented body shape with Basic auth; decodes base64 audioContent", async () => {
    installFetchMock();
    nextResponse = synthesisResponse(new Uint8Array([7, 8, 9]));

    const result = await backend().generate({ text: "Hello there.", voiceId: "Dennis" });

    const req = lastRequest();
    expect(req.url).toBe("https://api.inworld.ai/tts/v1/voice");
    expect(req.init.method).toBe("POST");
    // The key rides verbatim after "Basic " — the docs' own curl shape.
    expect(req.headers.get("Authorization")).toBe("Basic inworld_key");
    expect(req.headers.get("Content-Type")).toBe("application/json");
    expect(req.body).toEqual({
      text: "Hello there.",
      voiceId: "Dennis",
      modelId: "inworld-tts-2",
      audioConfig: { audioEncoding: "MP3" },
    });
    expect(Buffer.from(result.audio)).toEqual(Buffer.from([7, 8, 9]));
    expect(result.mime).toBe("audio/mpeg");
  });

  test("omits language when unset and passes it through when set", async () => {
    installFetchMock();
    nextResponse = synthesisResponse();

    await backend().generate({ text: "hi", voiceId: "Alex" });
    expect((lastRequest().body as Record<string, unknown>).language).toBeUndefined();

    await backend({ language: "ru-RU" }).generate({ text: "привет", voiceId: "Alex" });
    expect((lastRequest().body as Record<string, unknown>).language).toBe("ru-RU");
  });

  test("sends deliveryMode only for inworld-tts-2 (ignored field never rides on other models)", async () => {
    installFetchMock();
    nextResponse = synthesisResponse();

    await backend({ deliveryMode: "CREATIVE" }).generate({ text: "hi", voiceId: "Alex" });
    expect((lastRequest().body as Record<string, unknown>).deliveryMode).toBe("CREATIVE");

    await backend({ modelId: "inworld-tts-1.5-max", deliveryMode: "CREATIVE" }).generate({ text: "hi", voiceId: "Alex" });
    expect((lastRequest().body as Record<string, unknown>).deliveryMode).toBeUndefined();

    await backend({ modelId: "inworld-tts-1", deliveryMode: "STABLE" }).generate({ text: "hi", voiceId: "Alex" });
    expect((lastRequest().body as Record<string, unknown>).deliveryMode).toBeUndefined();
  });

  test("an invalid hand-edited deliveryMode value never reaches the wire", async () => {
    installFetchMock();
    nextResponse = synthesisResponse();

    await backend({ deliveryMode: "EXPRESSIVE" }).generate({ text: "hi", voiceId: "Alex" });
    expect((lastRequest().body as Record<string, unknown>).deliveryMode).toBeUndefined();
  });

  test("speed maps to audioConfig.speakingRate, clamped to the documented [0.5, 1.5]", async () => {
    installFetchMock();
    nextResponse = synthesisResponse();

    await backend({ speed: 1.2 }).generate({ text: "hi", voiceId: "Alex" });
    let body = lastRequest().body as { audioConfig: Record<string, unknown> };
    expect(body.audioConfig.speakingRate).toBe(1.2);

    await backend({ speed: 9 }).generate({ text: "hi", voiceId: "Alex" });
    body = lastRequest().body as { audioConfig: Record<string, unknown> };
    expect(body.audioConfig.speakingRate).toBe(1.5);

    await backend({ speed: 0.1 }).generate({ text: "hi", voiceId: "Alex" });
    body = lastRequest().body as { audioConfig: Record<string, unknown> };
    expect(body.audioConfig.speakingRate).toBe(0.5);
  });

  test("throws with an upstream excerpt on a non-2xx response", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ code: 3, message: "unknown voice: John not found" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });

    await expect(backend().generate({ text: "hi", voiceId: "John" })).rejects.toThrow(
      /Inworld text-to-speech failed with HTTP 400.*unknown voice/,
    );
  });

  test("throws when audioContent is missing from the response", async () => {
    installFetchMock();
    nextResponse = Response.json({ usage: { processedCharactersCount: 0 } });
    await expect(backend().generate({ text: "hi", voiceId: "Alex" })).rejects.toThrow(/missing 'audioContent'/);
  });

  test("requires a non-empty apiKey and voiceId", async () => {
    installFetchMock();
    await expect(inworldTtsFactory({}).generate({ text: "hi", voiceId: "Alex" })).rejects.toThrow(
      /requires a non-empty apiKey/,
    );
    await expect(backend().generate({ text: "hi", voiceId: "  " })).rejects.toThrow(/non-empty voiceId/);
    expect(recordedRequests.length).toBe(0);
  });
});

// ─── listVoices (GET /voices/v1/voices, pageToken pagination) ────────────────

describe("InworldTtsBackend.listVoices", () => {
  test("follows nextPageToken and maps entries to TtsVoiceInfo", async () => {
    installFetchMock();
    let call = 0;
    nextResponse = () => {
      call++;
      if (call === 1) {
        return Response.json({
          voices: [
            { voiceId: "Alex", displayName: "Alex", langCode: "EN_US", source: "SYSTEM", gender: "male" },
            { voiceId: "ws__my_clone", displayName: "My Clone", langCode: "RU_RU", source: "IVC" },
            { noVoiceId: true }, // filtered by the parse guard
          ],
          totalSize: 3,
          nextPageToken: "1-20",
        });
      }
      return Response.json({ voices: [{ voiceId: "Dennis", displayName: "Dennis", langCode: "EN_US", source: "SYSTEM" }], nextPageToken: "" });
    };

    const voices = await backend().listVoices();

    expect(voices).toEqual([
      { id: "Alex", label: "Alex · en-US", lang: "en-US" },
      { id: "ws__my_clone", label: "My Clone · ru-RU · mine", lang: "ru-RU" },
      { id: "Dennis", label: "Dennis · en-US", lang: "en-US" },
    ]);
    expect(recordedRequests.length).toBe(2);
    const firstUrl = new URL(recordedRequests[0]!.url);
    const secondUrl = new URL(recordedRequests[1]!.url);
    expect(firstUrl.pathname).toBe("/voices/v1/voices");
    expect(firstUrl.searchParams.get("pageSize")).toBe("100");
    expect(firstUrl.searchParams.get("pageToken")).toBeNull();
    expect(secondUrl.searchParams.get("pageToken")).toBe("1-20");
    expect(recordedRequests[1]!.headers.get("Authorization")).toBe("Basic inworld_key");
  });

  test("stops at the page cap even if nextPageToken never empties", async () => {
    installFetchMock();
    let n = 0;
    nextResponse = () => Response.json({ voices: [{ voiceId: `v-${n++}`, source: "SYSTEM" }], nextPageToken: "more" });

    const voices = await backend().listVoices();

    // 10 pages × 1 voice — the cap prevents an infinite cursor walk.
    expect(voices.length).toBe(10);
    expect(recordedRequests.length).toBe(10);
  });

  test("throws on a malformed payload", async () => {
    installFetchMock();
    nextResponse = Response.json({ nope: true });
    await expect(backend().listVoices()).rejects.toThrow(/missing the 'voices' array/);

    nextResponse = new Response("not json", { status: 200 });
    await expect(backend().listVoices()).rejects.toThrow();
  });
});

describe("parseVoicesPage", () => {
  test("guards the unknown boundary", () => {
    expect(() => parseVoicesPage(null)).toThrow(/non-object payload/);
    expect(() => parseVoicesPage({ voices: "no" })).toThrow(/missing the 'voices' array/);
    // nextPageToken absent → treated as empty (defensive stop).
    expect(parseVoicesPage({ voices: [{ voiceId: "a" }] })).toEqual({
      voices: [{ id: "a", label: "a · multi", lang: "multi" }],
      nextPageToken: "",
    });
  });
});

// ─── listModels (static documented catalog — no network) ─────────────────────

describe("InworldTtsBackend.listModels", () => {
  test("serves the static documented catalog without touching the network", async () => {
    installFetchMock();
    const models = await backend().listModels();
    expect(models.map((m) => m.id)).toEqual([
      "inworld-tts-2",
      "inworld-tts-1.5-max",
      "inworld-tts-1.5-mini",
      "inworld-tts-1-max",
      "inworld-tts-1",
    ]);
    expect(recordedRequests.length).toBe(0);
  });
});

// ─── probe (GET /voices/v1/voices?pageSize=1) ────────────────────────────────

describe("InworldTtsBackend.probe", () => {
  test("probes the cheapest authenticated call and reports ok", async () => {
    installFetchMock();
    nextResponse = Response.json({ voices: [], nextPageToken: "" });

    const result = await backend().probe();

    expect(result.ok).toBe(true);
    const url = new URL(lastRequest().url);
    expect(url.pathname).toBe("/voices/v1/voices");
    expect(url.searchParams.get("pageSize")).toBe("1");
  });

  test("surfaces HTTP failures and missing keys without throwing", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ code: 16, message: "Unauthenticated" }), { status: 401 });
    const failed = await backend().probe();
    expect(failed.ok).toBe(false);
    expect(failed.detail).toMatch(/401.*Unauthenticated/);

    const noKey = await inworldTtsFactory({}).probe();
    expect(noKey).toEqual({ ok: false, detail: "apiKey is required for Inworld." });
  });
});

// ─── cloneVoice (POST /voices/v1/voices:clone — JSON, base64 sample) ─────────

describe("InworldTtsBackend.cloneVoice", () => {
  test("sends a JSON body with base64 audioData + AUTO language and maps the response", async () => {
    installFetchMock();
    nextResponse = Response.json({
      voice: {
        voiceId: "ws__hero_20260831_z",
        displayName: "Hero Voice",
        langCode: "EN_US",
        source: "IVC",
      },
      audioSamplesValidated: [],
    });

    const voice = await backend().cloneVoice({
      name: "Hero Voice",
      referenceAudio: Buffer.from([9, 9, 9]),
      mimeType: "audio/wav",
    });

    expect(voice).toEqual({ id: "ws__hero_20260831_z", label: "Hero Voice · en-US · mine", lang: "en-US" });

    const req = lastRequest();
    expect(req.url).toBe("https://api.inworld.ai/voices/v1/voices:clone");
    expect(req.init.method).toBe("POST");
    expect(req.headers.get("Authorization")).toBe("Basic inworld_key");
    expect(req.headers.get("Content-Type")).toBe("application/json");
    // JSON body (not multipart): the sample rides as base64 audioData.
    expect(req.body).toEqual({
      displayName: "Hero Voice",
      langCode: "AUTO",
      voiceSamples: [{ audioData: Buffer.from([9, 9, 9]).toString("base64") }],
    });
  });

  test("maps config.language into the clone langCode enum", async () => {
    installFetchMock();
    nextResponse = Response.json({ voice: { voiceId: "c1", displayName: "N", langCode: "RU_RU" } });

    await backend({ language: "ru" }).cloneVoice({
      name: "N",
      referenceAudio: Buffer.from([1]),
      mimeType: "audio/mpeg",
    });
    expect((lastRequest().body as Record<string, unknown>).langCode).toBe("RU_RU");

    await backend({ language: "en" }).cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/wav" });
    expect((lastRequest().body as Record<string, unknown>).langCode).toBe("EN_US");

    // Unknown language tags fall back to AUTO (documented auto-detect).
    await backend({ language: "xx" }).cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/wav" });
    expect((lastRequest().body as Record<string, unknown>).langCode).toBe("AUTO");
  });

  test("throws with the upstream excerpt on failure", async () => {
    installFetchMock();
    nextResponse = new Response(
      JSON.stringify({ code: 7, message: "API key has insufficient access level for 'voices'" }),
      { status: 403 },
    );

    await expect(
      backend().cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/wav" }),
    ).rejects.toThrow(/Inworld voice clone failed with HTTP 403.*insufficient access level/);
  });

  test("throws when voice.voiceId is missing from the response", async () => {
    installFetchMock();
    nextResponse = Response.json({ audioSamplesValidated: [] });
    await expect(
      backend().cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/wav" }),
    ).rejects.toThrow(/missing voice\.voiceId/);
  });
});

// ─── capabilities / registry wiring ───────────────────────────────────────────

describe("InworldTtsBackend.capabilities", () => {
  test("declares static cloning with the documented sample hints", () => {
    const caps = backend().capabilities();
    expect(caps.supportsCloning).toBe(true);
    expect(caps.formats).toEqual(["wav", "mp3"]);
    expect(caps.maxSizeMb).toBe(10);
  });
});

describe("registry wiring (inworld)", () => {
  test("module import registers the factory under the inworld slug", () => {
    const created = createTtsBackend(TTS_BACKEND.Inworld, { apiKey: "k" });
    expect(created).toBeInstanceOf(InworldTtsBackend);
    expect(created.capabilities().supportsCloning).toBe(true);
  });
});
