import { afterEach, describe, expect, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import {
  AzureTtsBackend,
  azureTtsFactory,
  buildSsml,
  parseVoicesList,
} from "../src/domain/tts/backends/azure-tts.js";
import { createTtsBackend } from "../src/domain/tts/tts-registry.js";

function backend(config: Record<string, unknown> = {}): AzureTtsBackend {
  return azureTtsFactory({ apiKey: "az_key", region: "westus", ...config }) as AzureTtsBackend;
}

// ─── fetch mock helpers (house pattern — see tts-backend-deepgram.test.ts) ─

interface RecordedRequest {
  url: string;
  init: RequestInit;
  body: string | undefined;
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
    const body = typeof init?.body === "string" ? init.body : undefined;
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
  return new Response(bytes, { status: 200 });
}

// ─── Registry ────────────────────────────────────────────────────────────────

describe("Azure TTS registry", () => {
  test("slug registers through the factory map", () => {
    const created = createTtsBackend(TTS_BACKEND.Azure, { apiKey: "k", region: "westus" });
    expect(created instanceof AzureTtsBackend).toBe(true);
  });
});

// ─── generate ────────────────────────────────────────────────────────────────

describe("Azure generate", () => {
  test("posts SSML to the regional /cognitiveservices/v1 endpoint with the documented required headers", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    const result = await backend().generate({ text: "Hello there", voiceId: "en-US-JennyNeural" });

    const req = lastRequest();
    expect(req.url).toBe("https://westus.tts.speech.microsoft.com/cognitiveservices/v1");
    expect(req.headers.get("Ocp-Apim-Subscription-Key")).toBe("az_key");
    expect(req.headers.get("Content-Type")).toBe("application/ssml+xml");
    expect(req.headers.get("X-Microsoft-OutputFormat")).toBe("audio-24khz-96kbitrate-mono-mp3");
    // The docs' header table marks User-Agent REQUIRED — Bun's fetch sends
    // none by default (the ST reference only got away with it because
    // node-fetch injects one).
    expect(req.headers.get("User-Agent")).toBe("VibeTavern");

    expect(req.body).toBe(
      "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
        "<voice xml:lang='en-US' name='en-US-JennyNeural'>Hello there</voice></speak>",
    );

    // Raw audio file back; fixed mp3 output format → audio/mpeg.
    expect(Buffer.isBuffer(result.audio)).toBe(true);
    expect((result.audio as Buffer).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(result.mime).toBe("audio/mpeg");
  });

  test("SSML text is entity-escaped; locale is derived from the voice id", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend().generate({ text: "a & b < c > d", voiceId: "zh-HK-HiuMaanNeural" });

    const body = lastRequest().body ?? "";
    expect(body).toContain("xml:lang='zh-HK'");
    expect(body).toContain("a &amp; b &lt; c &gt; d");
  });

  test("prosody trio rides the SSML only when set, each in its documented relative form", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    // All-unset: byte-identical to the docs' minimal sample (no prosody).
    await backend().generate({ text: "t", voiceId: "en-US-GuyNeural" });
    expect(lastRequest().body).not.toContain("prosody");

    await backend({ ratePercent: 30, pitchSt: 2, volumePercent: -20 }).generate({ text: "t", voiceId: "en-US-GuyNeural" });
    expect(lastRequest().body).toContain("<prosody rate='+30%' pitch='+2st' volume='-20%'>t</prosody>");

    // Negative pitch keeps its sign; zero is an explicit value, not "unset".
    await backend({ pitchSt: 0 }).generate({ text: "t", voiceId: "en-US-GuyNeural" });
    expect(lastRequest().body).toContain("<prosody pitch='+0st'>t</prosody>");
  });

  test("tuning values are clamped to the documented ranges", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend({ ratePercent: 500, pitchSt: -99, volumePercent: 400 }).generate({ text: "t", voiceId: "en-US-GuyNeural" });
    expect(lastRequest().body).toContain("rate='+100%'");
    expect(lastRequest().body).toContain("pitch='-12st'");
    expect(lastRequest().body).toContain("volume='+100%'");
  });

  test("region and apiKey are REQUIRED before any request (the acceptance pin)", async () => {
    installFetchMock();
    let error: unknown;
    try {
      await azureTtsFactory({ apiKey: "k", region: "  " }).generate({ text: "t", voiceId: "v" });
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain("non-empty region");
    expect(recordedRequests).toHaveLength(0);

    error = undefined;
    try {
      await azureTtsFactory({ region: "westus" }).generate({ text: "t", voiceId: "v" });
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain("non-empty apiKey");
    expect(recordedRequests).toHaveLength(0);
  });

  test("empty voiceId fails fast — Azure documents NO default voice", async () => {
    installFetchMock();
    let error: unknown;
    try {
      await backend().generate({ text: "t", voiceId: "  " });
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain("non-empty voiceId");
    expect(recordedRequests).toHaveLength(0);
  });

  test("HTTP failure surfaces with status + body excerpt", async () => {
    installFetchMock();
    nextResponse = new Response("The subscription is unreachable", { status: 401 });
    let error: unknown;
    try {
      await backend().generate({ text: "t", voiceId: "en-US-GuyNeural" });
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain("HTTP 401");
    expect((error as Error).message).toContain("subscription is unreachable");
  });
});

// ─── listVoices (live regional roster — no hardcoded catalog) ───────────────

describe("Azure listVoices", () => {
  test("fetches the regional voices/list with the key header and maps entries", async () => {
    installFetchMock();
    nextResponse = Response.json([
      {
        Name: "Microsoft Server Speech Text to Speech Voice (en-US, JennyNeural)",
        DisplayName: "Jenny",
        LocalName: "Jenny",
        ShortName: "en-US-JennyNeural",
        Gender: "Female",
        Locale: "en-US",
        SampleRateHertz: "48000",
        VoiceType: "Neural",
        Status: "GA",
      },
      {
        ShortName: "en-US-AvaMultilingualHD",
        DisplayName: "Ava Multilingual",
        Gender: "Female",
        Locale: "en-US",
        VoiceType: "HDVoice",
        Status: "GA",
      },
      {
        ShortName: "ru-RU-DmitryNeural",
        DisplayName: "Dmitry",
        Gender: "Male",
        Locale: "ru-RU",
        VoiceType: "Neural",
        Status: "Deprecated",
      },
    ]);

    const voices = await backend().listVoices();

    const req = lastRequest();
    expect(req.url).toBe("https://westus.tts.speech.microsoft.com/cognitiveservices/voices/list");
    expect(req.headers.get("Ocp-Apim-Subscription-Key")).toBe("az_key");

    expect(voices.map((v) => v.id)).toEqual(["en-US-AvaMultilingualHD", "en-US-JennyNeural"]);
    const jenny = voices.find((v) => v.id === "en-US-JennyNeural");
    expect(jenny?.label).toBe("Jenny · Female · en-US");
    expect(jenny?.lang).toBe("en-us");
    // Non-Neural generation gets an explicit marker, never silent mixing.
    const ava = voices.find((v) => v.id === "en-US-AvaMultilingualHD");
    expect(ava?.label).toBe("Ava Multilingual · Female · en-US · HDVoice");
  });

  test("missing region fails before any request; non-array payload throws; garbage entries skipped", async () => {
    installFetchMock();
    let error: unknown;
    try {
      await azureTtsFactory({ apiKey: "k" }).listVoices();
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain("non-empty region");
    expect(recordedRequests).toHaveLength(0);

    expect(() => parseVoicesList({ tts: [] })).toThrow("non-array");
    expect(parseVoicesList(["garbage", { ShortName: "en-US-GuyNeural" }, 42])).toEqual([
      { id: "en-US-GuyNeural", label: "en-US-GuyNeural", lang: "" },
    ]);
  });

  test("HTTP failure surfaces with status + excerpt", async () => {
    installFetchMock();
    nextResponse = new Response("Access denied", { status: 401 });
    let error: unknown;
    try {
      await backend().listVoices();
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain("HTTP 401");
    expect((error as Error).message).toContain("Access denied");
  });
});

// ─── probe ───────────────────────────────────────────────────────────────────

describe("Azure probe", () => {
  test("missing region or key fails without a request — the region requirement is probe-visible", async () => {
    expect((await azureTtsFactory({ apiKey: "k" }).probe()).detail).toContain("region");
    expect((await azureTtsFactory({ region: "westus" }).probe()).detail).toContain("apiKey");

    installFetchMock();
    nextResponse = Response.json([]);
    expect((await backend().probe()).ok).toBe(true);

    nextResponse = new Response("Access denied", { status: 401 });
    const failed = await backend().probe();
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain("401");
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

// ─── SSML unit pins ─────────────────────────────────────────────────────────

describe("buildSsml", () => {
  test("localeFromVoiceId keeps language-CULTURE only", () => {
    expect(buildSsml("t", "en-US-JennyNeural", {})).toContain("xml:lang='en-US'");
    expect(buildSsml("t", "zh-HK-HiuMaanNeural", {})).toContain("xml:lang='zh-HK'");
    expect(buildSsml("t", "fr-CA-AntoineNeural", {})).toContain("name='fr-CA-AntoineNeural'");
  });
});

// ─── capabilities + dispose ─────────────────────────────────────────────────

describe("Azure capabilities + dispose", () => {
  test("NO cloning — the profile editor's clone section stays hidden (wave-B feature-detect source)", async () => {
    const caps = backend().capabilities();
    expect(caps.supportsCloning).toBe(false);
    expect(caps.formats).toBeUndefined();
    await backend().dispose();
  });
});
