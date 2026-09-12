import { afterEach, describe, expect, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import {
  DeepgramTtsBackend,
  deepgramTtsFactory,
  parseVoicesList,
} from "../src/domain/tts/backends/deepgram-tts.js";
import { createTtsBackend } from "../src/domain/tts/tts-registry.js";

function backend(config: Record<string, unknown> = {}): DeepgramTtsBackend {
  return deepgramTtsFactory({ apiKey: "dg_key", ...config }) as DeepgramTtsBackend;
}

// ─── fetch mock helpers (house pattern — see tts-backend-minimax.test.ts) ─

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
  return new Response(bytes, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
}

// ─── Registry ────────────────────────────────────────────────────────────────

describe("Deepgram TTS registry", () => {
  test("slug registers through the factory map", () => {
    const created = createTtsBackend(TTS_BACKEND.Deepgram, { apiKey: "k" });
    expect(created instanceof DeepgramTtsBackend).toBe(true);
  });
});

// ─── generate ────────────────────────────────────────────────────────────────

describe("Deepgram generate", () => {
  test("posts to /v1/speak with Token auth, model=voiceId in the query, and a {text} JSON body", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    const result = await backend().generate({ text: "Hello there", voiceId: "aura-2-thalia-en" });

    const req = lastRequest();
    expect(req.url).toBe("https://api.deepgram.com/v1/speak?model=aura-2-thalia-en");
    // The documented `Token` scheme (not Bearer).
    expect(req.headers.get("Authorization")).toBe("Token dg_key");
    expect(req.headers.get("Content-Type")).toBe("application/json");
    expect(req.body).toEqual({ text: "Hello there" });

    // Raw audio stream + mime from the content-type header.
    expect(Buffer.isBuffer(result.audio)).toBe(true);
    expect((result.audio as Buffer).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(result.mime).toBe("audio/mpeg");
  });

  test("empty voiceId omits the model param — the documented server default applies", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend().generate({ text: "hi", voiceId: "  " });
    expect(lastRequest().url).toBe("https://api.deepgram.com/v1/speak");
  });

  test("speed rides the query clamped to the documented 0.7–1.5; omitted when unset", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend({ speed: 5 }).generate({ text: "hi", voiceId: "v" });
    expect(lastRequest().url).toContain("speed=1.5");

    await backend({ speed: 0 }).generate({ text: "hi", voiceId: "v" });
    expect(lastRequest().url).toContain("speed=0.7");

    await backend().generate({ text: "hi", voiceId: "v" });
    expect(lastRequest().url).not.toContain("speed=");
  });

  test("missing apiKey throws before any fetch; HTTP failure surfaces with status + body excerpt", async () => {
    installFetchMock();
    let error: unknown;
    try {
      await deepgramTtsFactory({}).generate({ text: "hi", voiceId: "v" });
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain("non-empty apiKey");
    expect(recordedRequests).toHaveLength(0);

    nextResponse = new Response('{"errcode":402,"errmsg":"Insufficient balance"}', { status: 402 });
    error = undefined;
    try {
      await backend().generate({ text: "hi", voiceId: "v" });
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain("HTTP 402");
    expect((error as Error).message).toContain("Insufficient balance");
  });

  test("mime falls back to audio/mpeg when content-type is absent", async () => {
    installFetchMock();
    nextResponse = new Response(new Uint8Array([9]), { status: 200 });
    const result = await backend().generate({ text: "hi", voiceId: "v" });
    expect(result.mime).toBe("audio/mpeg");
  });
});

// ─── listVoices (live /v1/models catalog — no hardcoded roster) ─────────────

describe("Deepgram listVoices", () => {
  test("fetches GET /v1/models with Token auth and maps the tts array", async () => {
    installFetchMock();
    nextResponse = Response.json({
      stt: [{ name: "nova-3", canonical_name: "nova-3" }],
      tts: [
        {
          name: "zeus",
          canonical_name: "aura-2-zeus-en",
          architecture: "aura-2",
          languages: ["en", "en-US"],
          metadata: { accent: "American", age: "Adult", tags: ["masculine", "deep"] },
        },
        {
          name: "asteria",
          canonical_name: "aura-asteria-en",
          architecture: "aura",
          languages: ["en"],
          metadata: { accent: "American" },
        },
      ],
    });

    const voices = await backend().listVoices();

    const req = lastRequest();
    expect(req.url).toBe("https://api.deepgram.com/v1/models");
    expect(req.headers.get("Authorization")).toBe("Token dg_key");

    expect(voices).toHaveLength(2);
    const zeus = voices.find((v) => v.id === "aura-2-zeus-en");
    expect(zeus?.label).toBe("zeus · American · en-US");
    expect(zeus?.lang).toBe("en-us");
    // v1 voices carry the generation marker so pickers never mix silently.
    const asteria = voices.find((v) => v.id === "aura-asteria-en");
    expect(asteria?.label).toBe("asteria · American · en · aura-1");
  });

  test("HTTP failure surfaces with status + excerpt; non-tts entries skipped; bad ids shape-filtered; sorted by label", async () => {
    installFetchMock();
    nextResponse = new Response('{"reason":"invalid api key"}', { status: 401 });
    let error: unknown;
    try {
      await backend().listVoices();
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain("HTTP 401");
    expect((error as Error).message).toContain("invalid api key");

    nextResponse = Response.json({
      tts: [
        { canonical_name: "aura-2-zeus-en", name: "zeus" },
        { name: "broken" }, // no canonical_name
        "garbage", // not an object
      ],
    });
    const voices = await backend().listVoices();
    expect(voices.map((v) => v.id)).toEqual(["aura-2-zeus-en"]);
  });

  test("payload without a tts array throws a clear error", () => {
    expect(() => parseVoicesList({ stt: [] })).toThrow("tts");
    expect(() => parseVoicesList(null)).toThrow("non-object");
  });
});

// ─── probe ───────────────────────────────────────────────────────────────────

describe("Deepgram probe", () => {
  test("missing key fails without a request; 2xx passes; 401 fails with the status", async () => {
    const missing = await deepgramTtsFactory({}).probe();
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain("apiKey");

    installFetchMock();
    nextResponse = Response.json({ tts: [] });
    let result = await backend().probe();
    expect(result.ok).toBe(true);

    nextResponse = new Response('{"errcode":401,"errmsg":"invalid api key"}', { status: 401 });
    result = await backend().probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("401");
  });

  test("network errors degrade to a failed probe detail", async () => {
    installFetchMock();
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as typeof fetch;
    const result = await backend().probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("boom");
  });
});

// ─── capabilities + dispose ─────────────────────────────────────────────────

describe("Deepgram capabilities + dispose", () => {
  test("NO cloning — the profile editor's clone section stays hidden (TPE-10 wave-B feature-detect)", async () => {
    // The UI gate is `cloneCaps?.supportsCloning === true` (structural,
    // pinned generically in TtsProfileEditor.test.tsx): this backend pin
    // is the source of that payload.
    const caps = backend().capabilities();
    expect(caps.supportsCloning).toBe(false);
    expect(caps.formats).toBeUndefined();
    await backend().dispose();
  });
});
