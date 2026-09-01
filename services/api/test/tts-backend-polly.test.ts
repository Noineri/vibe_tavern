import { afterEach, describe, expect, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import {
  PollyTtsBackend,
  PollyTtsError,
  buildSsml,
  deriveSigV4SigningKey,
  pollyTtsFactory,
  sha256Hex,
  signSigV4Request,
} from "../src/domain/tts/backends/polly-tts.js";
import { createTtsBackend } from "../src/domain/tts/tts-registry.js";

function backend(config: Record<string, unknown> = {}): PollyTtsBackend {
  return pollyTtsFactory({
    apiKey: "secret",
    accessKeyId: "AKIAEXAMPLE",
    region: "us-east-1",
    ...config,
  }) as PollyTtsBackend;
}

// ─── fetch mock helpers (house pattern — see tts-backend-azure.test.ts) ─────

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

function voicesPage(voices: unknown[], nextToken?: string): Response {
  return new Response(JSON.stringify({ Voices: voices, ...(nextToken ? { NextToken: nextToken } : {}) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ─── Registry ────────────────────────────────────────────────────────────────

describe("Polly TTS registry", () => {
  test("slug registers through the factory map", () => {
    const created = createTtsBackend(TTS_BACKEND.Polly, { apiKey: "k", accessKeyId: "a", region: "us-east-1" });
    expect(created instanceof PollyTtsBackend).toBe(true);
  });

  test("capabilities report no cloning (hides the clone section)", () => {
    expect(backend().capabilities()).toEqual({ supportsCloning: false });
  });
});

// ─── SigV4 signer — official docs vector + canonicalization pins ────────────

describe("SigV4 derivation (official AWS docs vector)", () => {
  // signature-v4-examples.html: given key/date/region/service the chain
  // must produce exactly these hex digests — byte-pinned from the docs.
  const DOCS = {
    key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    date: "20120215",
    region: "us-east-1",
    service: "iam",
    kDate: "969fbb94feb542b71ede6f87fe4d5fa29c789342b0f407474670f0c2489e0a0d",
    kRegion: "69daa0209cd9c5ff5c8ced464a696fd4252e981430b10e3d3fd8e2f197d7a70c",
    kService: "f72cfd46f26bc4643f06a11eabb6c0ba18780c19a8da0c31ace671265e3c87fa",
    kSigning: "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
  };

  test("kSigning matches the docs byte-for-byte via the full chain fn", () => {
    expect(deriveSigV4SigningKey(DOCS.key, DOCS.date, DOCS.region, DOCS.service).toString("hex")).toBe(DOCS.kSigning);
  });

  test("sha256Hex of the empty string is the documented constant", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("SigV4 request signing (Polly shapes)", () => {
  const CREDENTIALS = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-2",
    service: "polly",
  };

  test("GET voices: signs host + x-amz-date, deterministic Authorization", () => {
    const signed = signSigV4Request({
      ...CREDENTIALS,
      method: "GET",
      url: "https://polly.us-east-2.amazonaws.com/v1/voices",
      datetime: "20150830T123600Z",
    });
    expect(signed.headers["x-amz-date"]).toBe("20150830T123600Z");
    // No comma after the algorithm (docs); SignedHeaders = host;x-amz-date
    // (GET sets no content-type); the signature is a stable 64-hex digest.
    expect(signed.headers["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20150830\/us-east-2\/polly\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    // Golden value: any change in canonicalization/crypto moves this.
    expect(signed.headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20150830/us-east-2/polly/aws4_request, SignedHeaders=host;x-amz-date, Signature=1b2c41a972dc670f1fc322b599c8410a6b8ead33e355fef4a9b545abc2872743",
    );
  });

  test("POST speech: content-type is signed (docs: present → canonical)", () => {
    const signed = signSigV4Request({
      ...CREDENTIALS,
      method: "POST",
      url: "https://polly.us-east-2.amazonaws.com/v1/speech",
      headers: { "content-type": "application/json" },
      body: "{}",
      datetime: "20150830T123600Z",
    });
    expect(signed.headers["content-type"]).toBe("application/json");
    expect(signed.headers["authorization"]).toContain("SignedHeaders=content-type;host;x-amz-date");
  });

  test("base64 NextToken query encodes and sorts canonically (= → %3D)", () => {
    const signed = signSigV4Request({
      ...CREDENTIALS,
      method: "GET",
      url: "https://polly.us-east-2.amazonaws.com/v1/voices?NextToken=ab+cd/ef==&Engine=neural",
      datetime: "20150830T123600Z",
    });
    // The URL's own query keeps its raw form for the wire; the signature
    // covers the CANONICAL form (RFC3986-encoded, sorted). We pin the
    // golden Authorization — if the canonical query changes, this moves.
    expect(signed.headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20150830/us-east-2/polly/aws4_request, SignedHeaders=host;x-amz-date, Signature=5e635d8f0a265249a8a19b924929ff6c3cc86ce3d0c540d1521db607466c846e",
    );
  });

  test("signature is deterministic for identical inputs, moves with any part", () => {
    const params = {
      ...CREDENTIALS,
      method: "GET",
      url: "https://polly.us-east-2.amazonaws.com/v1/voices",
      datetime: "20150830T123600Z",
    };
    const a = signSigV4Request(params).headers["authorization"];
    const b = signSigV4Request(params).headers["authorization"];
    expect(a).toBe(b);
    const otherRegion = signSigV4Request({ ...params, region: "eu-west-1" }).headers["authorization"];
    expect(otherRegion).not.toBe(a);
  });
});

// ─── generate ────────────────────────────────────────────────────────────────

describe("Polly generate", () => {
  test("posts the documented JSON body to the regional /v1/speech endpoint", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    const result = await backend().generate({ text: "Hello there", voiceId: "Joanna" });

    const req = lastRequest();
    expect(req.url).toBe("https://polly.us-east-1.amazonaws.com/v1/speech");
    expect(req.init.method).toBe("POST");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
    const body = JSON.parse(req.body!) as Record<string, unknown>;
    expect(body["OutputFormat"]).toBe("mp3");
    expect(body["Text"]).toBe("Hello there");
    expect(body["VoiceId"]).toBe("Joanna");
    // Plain text (no tuning) → TextType omitted (docs default: text).
    expect(body["TextType"]).toBeUndefined();
    expect(body["Engine"]).toBeUndefined();
    // Response carries no content-type header in the mock → the docs'
    // format table applies (mp3 → audio/mpeg).
    expect(result.mime).toBe("audio/mpeg");
    expect(Array.from(result.audio)).toEqual([1, 2, 3]);
  });

  test("engine passthrough: documented value reaches the body", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend({ engine: "neural" }).generate({ text: "Hi", voiceId: "Joanna" });

    const body = JSON.parse(lastRequest().body!) as Record<string, unknown>;
    expect(body["Engine"]).toBe("neural");
  });

  test("engine guard: an invalid hand-edited value is dropped, not sent", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend({ engine: "turbo" }).generate({ text: "Hi", voiceId: "Joanna" });

    const body = JSON.parse(lastRequest().body!) as Record<string, unknown>;
    expect(body["Engine"]).toBeUndefined();
  });

  test("tuning switches to TextType ssml with the prosody envelope", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend({ ratePercent: 85, volumeDb: -6 }).generate({ text: "Calm <speech>", voiceId: "Joanna" });

    const body = JSON.parse(lastRequest().body!) as Record<string, unknown>;
    expect(body["TextType"]).toBe("ssml");
    // rate is ABSOLUTE percent (85% — no sign); volume is relative dB.
    expect(body["Text"]).toBe("<speak><prosody rate='85%' volume='-6dB'>Calm &lt;speech&gt;</prosody></speak>");
  });

  test("neutral tuning values keep the plain-text body (100% / 0 dB)", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend({ ratePercent: 100, volumeDb: 0 }).generate({ text: "Hi", voiceId: "Joanna" });

    const body = JSON.parse(lastRequest().body!) as Record<string, unknown>;
    expect(body["Text"]).toBe("Hi");
    expect(body["TextType"]).toBeUndefined();
  });

  test("tuning values clamp to the documented ranges", async () => {
    installFetchMock();
    nextResponse = audioResponse();

    await backend({ ratePercent: 999, volumeDb: -99 }).generate({ text: "Hi", voiceId: "Joanna" });

    const body = JSON.parse(lastRequest().body!) as Record<string, unknown>;
    expect(body["Text"]).toBe("<speak><prosody rate='200%' volume='-12dB'>Hi</prosody></speak>");
  });

  test("missing credentials fail before any request", async () => {
    installFetchMock();
    for (const config of [{ apiKey: "" }, { accessKeyId: "" }, { region: "" }] as Record<string, unknown>[]) {
      await expect(backend(config).generate({ text: "Hi", voiceId: "Joanna" })).rejects.toThrow(PollyTtsError);
    }
    expect(recordedRequests.length).toBe(0);
  });

  test("empty voiceId fails fast (VoiceId is required, no documented default)", async () => {
    installFetchMock();
    await expect(backend().generate({ text: "Hi", voiceId: "  " })).rejects.toThrow(/voiceId/);
    expect(recordedRequests.length).toBe(0);
  });

  test("403 surfaces status and body excerpt", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ __type: "UnrecognizedClientException", message: "bad signature" }), {
      status: 403,
    });

    await expect(backend().generate({ text: "Hi", voiceId: "Joanna" })).rejects.toThrow(/HTTP 403.*bad signature/s);
  });
});

// ─── listVoices ──────────────────────────────────────────────────────────────

describe("Polly listVoices", () => {
  test("maps the roster: Name · Gender · LanguageName, lang lowercase, sorted", async () => {
    installFetchMock();
    nextResponse = voicesPage([
      {
        Id: "Joanna",
        Name: "Joanna",
        Gender: "Female",
        LanguageCode: "en-US",
        LanguageName: "US English",
        SupportedEngines: ["standard", "neural", "generative"],
      },
      {
        Id: "Tatyana",
        Name: "Tatyana",
        Gender: "Female",
        LanguageCode: "ru-RU",
        LanguageName: "Russian",
        SupportedEngines: ["standard"],
      },
    ]);

    const voices = await backend().listVoices();

    expect(voices).toEqual([
      { id: "Joanna", label: "Joanna · Female · US English", lang: "en-us" },
      { id: "Tatyana", label: "Tatyana · Female · Russian", lang: "ru-ru" },
    ]);
    const req = lastRequest();
    expect(req.url).toBe("https://polly.us-east-1.amazonaws.com/v1/voices");
    expect(req.headers.get("authorization")).toMatch(/SignedHeaders=host;x-amz-date/);
  });

  test("neural-only voices carry the engines marker (the standard-default trap)", async () => {
    installFetchMock();
    nextResponse = voicesPage([
      {
        Id: "Lisa",
        Name: "Lisa",
        Gender: "Female",
        LanguageCode: "it-IT",
        LanguageName: "Italian",
        SupportedEngines: ["neural", "generative"],
      },
    ]);

    const voices = await backend().listVoices();
    expect(voices[0]?.label).toBe("Lisa · Female · Italian · neural,generative");
  });

  test("follows the opaque NextToken pagination until it disappears", async () => {
    installFetchMock();
    const token = "abc+def/ghi==";
    const responses = [
      voicesPage([{ Id: "A", Name: "A", Gender: "Female", LanguageCode: "en-US", SupportedEngines: ["standard"] }], token),
      voicesPage([{ Id: "B", Name: "B", Gender: "Male", LanguageCode: "en-US", SupportedEngines: ["standard"] }]),
    ];
    let call = 0;
    nextResponse = () => responses[call++]!;

    const voices = await backend().listVoices();

    expect(voices.length).toBe(2);
    expect(recordedRequests.length).toBe(2);
    // The wire URL carries the token; the signer canonicalizes it (pinned
    // separately above) — here we pin the wire form.
    expect(recordedRequests[1]?.url).toBe(`https://polly.us-east-1.amazonaws.com/v1/voices?NextToken=${encodeURIComponent(token)}`);
  });

  test("a repeated hostile token stops the loop instead of hanging", async () => {
    installFetchMock();
    const token = "loop";
    nextResponse = () => voicesPage([], token);

    const voices = await backend().listVoices();
    expect(voices).toEqual([]);
    // First request + the first repeat that detects the cycle.
    expect(recordedRequests.length).toBe(2);
  });

  test("garbage entries are filtered, missing names fall back to Id", async () => {
    installFetchMock();
    nextResponse = voicesPage([
      "not-a-voice",
      null,
      { Id: "NoMeta" },
      { Gender: "Female" },
    ]);

    const voices = await backend().listVoices();
    expect(voices).toEqual([{ id: "NoMeta", label: "NoMeta", lang: "" }]);
  });

  test("payload without a Voices array throws", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ message: "nope" }), { status: 200 });

    await expect(backend().listVoices()).rejects.toThrow(/Voices array/);
  });

  test("HTTP failure surfaces status and excerpt", async () => {
    installFetchMock();
    nextResponse = new Response("Forbidden", { status: 403 });

    await expect(backend().listVoices()).rejects.toThrow(/HTTP 403/);
  });
});

// ─── probe ───────────────────────────────────────────────────────────────────

describe("Polly probe", () => {
  test("missing credentials fail without any request", async () => {
    installFetchMock();
    expect((await backend({ apiKey: "" }).probe()).ok).toBe(false);
    expect((await backend({ accessKeyId: "" }).probe()).ok).toBe(false);
    expect((await backend({ region: "" }).probe()).ok).toBe(false);
    expect(recordedRequests.length).toBe(0);
  });

  test("200 on the voices list passes", async () => {
    installFetchMock();
    nextResponse = voicesPage([]);

    const probe = await backend().probe();
    expect(probe.ok).toBe(true);
    expect(lastRequest().url).toBe("https://polly.us-east-1.amazonaws.com/v1/voices");
  });

  test("403 (bad signature/creds) fails with the status in the detail", async () => {
    installFetchMock();
    nextResponse = new Response("Forbidden", { status: 403 });

    const probe = await backend().probe();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("403");
  });

  test("transport failure surfaces the message", async () => {
    installFetchMock();
    globalThis.fetch = (async () => {
      throw new Error("dns gone");
    }) as typeof fetch;

    const probe = await backend().probe();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("dns gone");
  });
});

// ─── SSML envelope unit pins ─────────────────────────────────────────────────

describe("buildSsml", () => {
  test("no tuning → bare escaped speak (never emitted by generate, safety net)", () => {
    expect(buildSsml("a & b", {})).toBe("<speak>a &amp; b</speak>");
  });

  test("rate alone — absolute percent", () => {
    expect(buildSsml("x", { ratePercent: 150 })).toBe("<speak><prosody rate='150%'>x</prosody></speak>");
  });

  test("volume alone — signed dB", () => {
    expect(buildSsml("x", { volumeDb: 4 })).toBe("<speak><prosody volume='+4dB'>x</prosody></speak>");
  });

  test("neutral values are normalized away", () => {
    expect(buildSsml("x", { ratePercent: 100, volumeDb: 0 })).toBe("<speak>x</speak>");
  });
});
