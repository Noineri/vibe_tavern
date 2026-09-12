import { afterEach, describe, expect, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import { LmntTtsBackend, lmntTtsFactory, parseVoicesList } from "../src/domain/tts/backends/lmnt-tts.js";
import { createTtsBackend } from "../src/domain/tts/tts-registry.js";

function backend(config: Record<string, unknown> = {}): LmntTtsBackend {
  return lmntTtsFactory({ apiKey: "lmnt_key", ...config }) as LmntTtsBackend;
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
    } else if (init?.body instanceof FormData) {
      body = init.body;
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

// The bytes endpoint answers with the raw binary audio stream.
function audioResponse(bytes: Uint8Array = new Uint8Array([1, 2, 3])): Response {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: { "content-type": "audio/mpeg" },
  });
}

// ─── generate (POST /v1/ai/speech/bytes) ─────────────────────────────────────

describe("LmntTtsBackend.generate", () => {
  test("sends the documented body shape with X-API-Key; returns raw bytes as audio", async () => {
    installFetchMock();
    nextResponse = audioResponse(new Uint8Array([7, 8, 9]));

    const result = await backend().generate({ text: "Hello there.", voiceId: "leah" });

    const req = lastRequest();
    expect(req.url).toBe("https://api.lmnt.com/v1/ai/speech/bytes");
    expect(req.init.method).toBe("POST");
    expect(req.headers.get("X-API-Key")).toBe("lmnt_key");
    expect(req.headers.get("Content-Type")).toBe("application/json");
    // Default model + mp3 default format (format not sent — mp3 is the
    // endpoint default); no top_p/temperature when unset.
    expect(req.body).toEqual({ voice: "leah", text: "Hello there.", model: "blizzard" });
    expect(Buffer.from(result.audio)).toEqual(Buffer.from([7, 8, 9]));
    expect(result.mime).toBe("audio/mpeg");
  });

  test("sends a configured model verbatim", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend({ modelId: "aurora" }).generate({ text: "hi", voiceId: "leah" });
    expect((lastRequest().body as Record<string, unknown>).model).toBe("aurora");
  });

  test("topP and temperature ride along and topP is clamped to the documented [0, 1]", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend({ topP: 0.4, temperature: 0.7 }).generate({ text: "hi", voiceId: "leah" });
    let body = lastRequest().body as Record<string, unknown>;
    expect(body.top_p).toBe(0.4);
    expect(body.temperature).toBe(0.7);

    await backend({ topP: 9 }).generate({ text: "hi", voiceId: "leah" });
    body = lastRequest().body as Record<string, unknown>;
    expect(body.top_p).toBe(1);

    await backend({ topP: -1 }).generate({ text: "hi", voiceId: "leah" });
    body = lastRequest().body as Record<string, unknown>;
    expect(body.top_p).toBe(0);
  });

  test("temperature is bounded below at the documented 0 (no upper clamp)", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend({ temperature: -3 }).generate({ text: "hi", voiceId: "leah" });
    expect((lastRequest().body as Record<string, unknown>).temperature).toBe(0);

    // The docs bound temperature only below; 1.4 passes through untouched.
    await backend({ temperature: 1.4 }).generate({ text: "hi", voiceId: "leah" });
    expect((lastRequest().body as Record<string, unknown>).temperature).toBe(1.4);
  });

  test("req.speed is ignored — LMNT has no speed parameter (config-owned tuning)", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend().generate({ text: "hi", voiceId: "leah", speed: 2 });
    const body = lastRequest().body as Record<string, unknown>;
    expect(body.speed).toBeUndefined();
    expect(body.speakingRate).toBeUndefined();
  });

  test("throws with an upstream excerpt on a non-2xx response", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ error: "voice not found: nope" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });

    await expect(backend().generate({ text: "hi", voiceId: "nope" })).rejects.toThrow(
      /LMNT text-to-speech failed with HTTP 400.*voice not found/,
    );
  });

  test("requires a non-empty apiKey and voiceId", async () => {
    installFetchMock();
    await expect(lmntTtsFactory({}).generate({ text: "hi", voiceId: "leah" })).rejects.toThrow(
      /requires a non-empty apiKey/,
    );
    await expect(backend().generate({ text: "hi", voiceId: "  " })).rejects.toThrow(/non-empty voiceId/);
    expect(recordedRequests.length).toBe(0);
  });
});

// ─── listVoices (GET /v1/ai/voice/list — flat array, no pagination) ──────────

describe("LmntTtsBackend.listVoices", () => {
  test("fetches owner=all and maps the flat array to TtsVoiceInfo", async () => {
    installFetchMock();
    nextResponse = Response.json([
      {
        id: "leah",
        name: "Leah",
        owner: "system",
        starred: true,
        state: "ready",
        type: "professional",
        description: "US. Middle-aged. Friendly",
        gender: "female",
      },
      {
        id: "abc123",
        name: "My Clone",
        owner: "me",
        state: "ready",
        type: "instant",
      },
      {
        id: "training-1",
        name: "Still Training",
        owner: "me",
        state: "training",
        type: "professional",
      },
      { noId: true }, // filtered by the parse guard
    ]);

    const voices = await backend().listVoices();

    // Training voices are hidden — they cannot synthesize yet.
    expect(voices).toEqual([
      { id: "leah", label: "Leah · US", lang: "us" },
      { id: "abc123", label: "My Clone · voice · mine", lang: "voice" },
    ]);

    const url = new URL(lastRequest().url);
    expect(url.pathname).toBe("/v1/ai/voice/list");
    expect(url.searchParams.get("owner")).toBe("all");
    expect(lastRequest().headers.get("X-API-Key")).toBe("lmnt_key");
  });

  test("throws on a non-array payload", async () => {
    installFetchMock();
    nextResponse = Response.json({ voices: [] });
    await expect(backend().listVoices()).rejects.toThrow(/non-array payload/);

    nextResponse = new Response("not json", { status: 200 });
    await expect(backend().listVoices()).rejects.toThrow();
  });
});

describe("parseVoicesList", () => {
  test("guards the unknown boundary", () => {
    expect(() => parseVoicesList(null)).toThrow(/non-array payload/);
    expect(() => parseVoicesList({})).toThrow(/non-array payload/);
    expect(parseVoicesList([])).toEqual([]);
  });
});

// ─── probe (GET /v1/ai/voice/list?owner=me) ─────────────────────────────────

describe("LmntTtsBackend.probe", () => {
  test("probes the cheapest authenticated call and reports ok", async () => {
    installFetchMock();
    nextResponse = Response.json([]);

    const result = await backend().probe();

    expect(result.ok).toBe(true);
    const url = new URL(lastRequest().url);
    expect(url.pathname).toBe("/v1/ai/voice/list");
    expect(url.searchParams.get("owner")).toBe("me");
  });

  test("surfaces HTTP failures and missing keys without throwing", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ message: "Unauthorized", status: 401 }), { status: 401 });
    const failed = await backend().probe();
    expect(failed.ok).toBe(false);
    expect(failed.detail).toMatch(/401.*Unauthorized/);

    const noKey = await lmntTtsFactory({}).probe();
    expect(noKey).toEqual({ ok: false, detail: "apiKey is required for LMNT." });
  });
});

// ─── cloneVoice (POST /v1/ai/voice — multipart form-data) ────────────────────

describe("LmntTtsBackend.cloneVoice", () => {
  test("sends multipart name/enhance/files and maps the created voice", async () => {
    installFetchMock();
    nextResponse = Response.json({
      id: "xyz987",
      name: "Hero Voice",
      owner: "me",
      state: "ready",
      starred: false,
      type: "instant",
      gender: "male",
    });

    const voice = await backend().cloneVoice({
      name: "Hero Voice",
      referenceAudio: Buffer.from([9, 9, 9]),
      mimeType: "audio/wav",
    });

    expect(voice).toEqual({ id: "xyz987", label: "Hero Voice · voice · mine", lang: "voice" });

    const req = lastRequest();
    expect(req.url).toBe("https://api.lmnt.com/v1/ai/voice");
    expect(req.init.method).toBe("POST");
    expect(req.headers.get("X-API-Key")).toBe("lmnt_key");
    // No Content-Type — fetch derives the multipart boundary itself.
    expect(req.headers.get("Content-Type")).toBeNull();
    expect(req.body).toBeInstanceOf(FormData);
    const form = req.body as FormData;
    expect(form.get("name")).toBe("Hero Voice");
    // enhance rides as the required boolean (docs default false).
    expect(form.get("enhance")).toBe("false");
    const file = form.get("files");
    expect(file).toBeInstanceOf(Blob);
    // The extension keys the filename (LMNT sniffs the container).
    expect((file as File).name).toBe("clip.wav");
    expect((file as File).type).toBe("audio/wav");
  });

  test("maps the mime type to the documented attachment formats", async () => {
    installFetchMock();
    nextResponse = Response.json({ id: "c1", name: "N", owner: "me", state: "ready" });

    await backend().cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/mp4" });
    expect(((lastRequest().body as FormData).get("files") as File).name).toBe("clip.mp4");

    await backend().cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/webm" });
    expect(((lastRequest().body as FormData).get("files") as File).name).toBe("clip.webm");

    await backend().cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/mpeg" });
    expect(((lastRequest().body as FormData).get("files") as File).name).toBe("clip.mp3");
  });

  test("throws with the upstream excerpt on failure", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ error: "plan limit exceeded" }), { status: 402 });

    await expect(
      backend().cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/wav" }),
    ).rejects.toThrow(/LMNT voice clone failed with HTTP 402.*plan limit exceeded/);
  });

  test("throws when the response carries no voice id", async () => {
    installFetchMock();
    nextResponse = Response.json({ name: "N" });
    await expect(
      backend().cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/wav" }),
    ).rejects.toThrow(/missing the 'id' field/);
  });
});

// ─── capabilities / registry wiring ───────────────────────────────────────────

describe("LmntTtsBackend.capabilities", () => {
  test("declares static cloning with the documented attachment hints", () => {
    const caps = backend().capabilities();
    expect(caps.supportsCloning).toBe(true);
    expect(caps.formats).toEqual(["wav", "mp3", "mp4", "m4a", "webm"]);
    expect(caps.maxSizeMb).toBe(250);
  });
});

describe("registry wiring (lmnt)", () => {
  test("module import registers the factory under the lmnt slug", () => {
    const created = createTtsBackend(TTS_BACKEND.Lmnt, { apiKey: "k" });
    expect(created).toBeInstanceOf(LmntTtsBackend);
    expect(created.capabilities().supportsCloning).toBe(true);
  });
});
