import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync, type KeyObject } from "node:crypto";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import {
  GoogleCloudTtsBackend,
  GoogleCloudTtsError,
  __resetGoogleTokenCacheForTests,
  buildSynthesizeBody,
  googleCloudTtsFactory,
  languageCodeFromVoiceName,
  parseServiceAccount,
  signServiceAccountJwt,
} from "../src/domain/tts/backends/google-cloud-tts.js";
import { createTtsBackend } from "../src/domain/tts/tts-registry.js";

// ─── Test identity: a REAL RSA keypair — the JWT signature must verify ──────
//
// Google publishes no byte-vector for the full JWT (the docs examples carry
// stripped keys), so the correctness proof is end-to-end: sign with the
// private PEM, verify with the public PEM via node:crypto verify().

let privateKeyPem: string;
let publicKeyPem: string;
let serviceAccountJson: string;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  serviceAccountJson = JSON.stringify({
    type: "service_account",
    client_email: "vt-tts@test-project.iam.gserviceaccount.com",
    private_key: privateKeyPem,
    private_key_id: "testkeyid123",
    token_uri: "https://oauth2.googleapis.com/token",
  });
});

function backend(config: Record<string, unknown> = {}): GoogleCloudTtsBackend {
  return googleCloudTtsFactory({ apiKey: serviceAccountJson, ...config }) as GoogleCloudTtsBackend;
}

// ─── fetch mock helpers (house pattern — see tts-backend-polly.test.ts) ─────

interface RecordedRequest {
  url: string;
  init: RequestInit;
  body: string | undefined;
  headers: Headers;
}

let recordedRequests: RecordedRequest[] = [];
let responseQueue: Response[] = [];

// Snapshot BEFORE any mock is installed: restoring via the bare `fetch`
// identifier would read the CURRENT (mocked) global and no-op, leaking the
// mock into later files in this process.
const originalFetch = globalThis.fetch;

function installFetchMock(): void {
  recordedRequests = [];
  responseQueue = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : undefined;
    recordedRequests.push({ url, init: init ?? {}, body, headers });
    const response = responseQueue.shift();
    if (response === undefined) throw new Error("test mock: unexpected fetch (queue empty)");
    return response.clone();
  }) as typeof fetch;
}

/** A successful token exchange (the documented response shape). */
function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({ access_token: "TEST_ACCESS_TOKEN", expires_in: 3600, token_type: "Bearer", ...overrides });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function synthesizeResponse(bytes: Uint8Array = new Uint8Array([9, 8, 7])): Response {
  return jsonResponse({ audioContent: Buffer.from(bytes).toString("base64") });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  __resetGoogleTokenCacheForTests();
});

function lastRequest(): RecordedRequest {
  expect(recordedRequests.length).toBeGreaterThan(0);
  return recordedRequests[recordedRequests.length - 1]!;
}

// ─── Registry ────────────────────────────────────────────────────────────────

describe("Google Cloud TTS registry", () => {
  test("slug registers through the factory map", () => {
    const created = createTtsBackend(TTS_BACKEND.GoogleCloud, { apiKey: serviceAccountJson });
    expect(created instanceof GoogleCloudTtsBackend).toBe(true);
  });

  test("capabilities report no cloning (hides the clone section)", () => {
    expect(backend().capabilities()).toEqual({ supportsCloning: false });
  });
});

// ─── Service-account parsing ─────────────────────────────────────────────────

describe("parseServiceAccount (pre-fetch guards)", () => {
  test("parses the documented fields, keeps kid, defaults token_uri", () => {
    const account = parseServiceAccount(
      JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nX" }),
    );
    expect(account.client_email).toBe("a@b.iam.gserviceaccount.com");
    expect(account.private_key_id).toBeUndefined();
    expect(account.token_uri).toBe("https://oauth2.googleapis.com/token");
  });

  test("uses the file's token_uri when present", () => {
    const account = parseServiceAccount(serviceAccountJson);
    expect(account.token_uri).toBe("https://oauth2.googleapis.com/token");
    expect(account.private_key_id).toBe("testkeyid123");
  });

  test("non-JSON → named error naming the expected format", () => {
    expect(() => parseServiceAccount("not json at all")).toThrow(/service-account JSON/);
  });

  test("missing client_email / private_key → named errors", () => {
    expect(() => parseServiceAccount(JSON.stringify({ private_key: "k" }))).toThrow(/client_email/);
    expect(() => parseServiceAccount(JSON.stringify({ client_email: "a@b" }))).toThrow(/private_key/);
  });
});

// ─── JWT signing — verified against the RSA public key ──────────────────────

describe("signServiceAccountJwt (RS256, documented claim set)", () => {
  const account = () => parseServiceAccount(serviceAccountJson);

  test("signature verifies with the public key (RSASSA-PKCS1-v1_5 + SHA-256)", () => {
    const jwt = signServiceAccountJwt({ serviceAccount: account(), nowSeconds: 1_700_000_000 });
    const parts = jwt.split(".");
    expect(parts.length).toBe(3);
    // base64url WITHOUT padding (docs: "without newlines or padding equal signs").
    for (const part of parts) expect(part).not.toContain("=");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    expect(verifier.verify(publicKeyPem, Buffer.from(parts[2]!, "base64url"))).toBe(true);
    // …and a tampered payload must FAIL the same check.
    const bad = createVerify("RSA-SHA256");
    bad.update(`${parts[0]}.${parts[1]!.slice(0, -2)}xx`);
    expect(bad.verify(publicKeyPem, Buffer.from(parts[2]!, "base64url"))).toBe(false);
  });

  test("header carries alg/typ/kid; kid omitted when the file has none", () => {
    const header = JSON.parse(Buffer.from(signServiceAccountJwt({ serviceAccount: account() }).split(".")[0]!, "base64url").toString("utf8"));
    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: "testkeyid123" });
    const bare = parseServiceAccount(
      JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: privateKeyPem }),
    );
    const bareHeader = JSON.parse(Buffer.from(signServiceAccountJwt({ serviceAccount: bare }).split(".")[0]!, "base64url").toString("utf8"));
    expect(bareHeader).toEqual({ alg: "RS256", typ: "JWT" });
  });

  test("claims: iss=client_email, scope=cloud-platform, aud=token_uri, exp−iat = 3600", () => {
    const claims = JSON.parse(
      Buffer.from(
        signServiceAccountJwt({ serviceAccount: account(), nowSeconds: 1_700_000_000 }).split(".")[1]!,
        "base64url",
      ).toString("utf8"),
    );
    expect(claims["iss"]).toBe("vt-tts@test-project.iam.gserviceaccount.com");
    expect(claims["scope"]).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(claims["aud"]).toBe("https://oauth2.googleapis.com/token");
    expect(claims["iat"]).toBe(1_700_000_000);
    expect(claims["exp"] - claims["iat"]).toBe(3600);
  });
});

// ─── languageCode derivation ─────────────────────────────────────────────────

describe("languageCodeFromVoiceName (VoiceSelectionParams.languageCode)", () => {
  test("first two segments — including hyphenated engine families", () => {
    expect(languageCodeFromVoiceName("en-US-Neural2-F")).toBe("en-US");
    expect(languageCodeFromVoiceName("en-US-Chirp3-HD-Achird")).toBe("en-US");
    expect(languageCodeFromVoiceName("cmn-CN-Standard-A")).toBe("cmn-CN");
    expect(languageCodeFromVoiceName("ru-RU-Wavenet-A")).toBe("ru-RU");
  });

  test("degenerate un-prefixed id passes through (never happens per the roster)", () => {
    expect(languageCodeFromVoiceName("Joanna")).toBe("Joanna");
  });
});

// ─── Request shaping (exported pins) ─────────────────────────────────────────

describe("buildSynthesizeBody", () => {
  test("documented shape; neutral tuning values omitted", () => {
    expect(buildSynthesizeBody({ text: "Hi", voiceName: "en-US-Neural2-F", speakingRate: 1, pitchSt: 0, volumeGainDb: 0 })).toEqual({
      input: { text: "Hi" },
      voice: { languageCode: "en-US", name: "en-US-Neural2-F" },
      audioConfig: { audioEncoding: "MP3" },
    });
  });

  test("real adjustments ride audioConfig (pitch → `pitch`, volume → `volumeGainDb`)", () => {
    const body = buildSynthesizeBody({ text: "Hi", voiceName: "ru-RU-Wavenet-A", speakingRate: 1.5, pitchSt: -2, volumeGainDb: 4 });
    expect(body["audioConfig"]).toEqual({ audioEncoding: "MP3", speakingRate: 1.5, pitch: -2, volumeGainDb: 4 });
    expect((body["voice"] as Record<string, unknown>)["languageCode"]).toBe("ru-RU");
  });
});

// ─── Token exchange + module cache ───────────────────────────────────────────

describe("OAuth token exchange", () => {
  test("documented wire form: form-encoded grant_type + assertion to token_uri", async () => {
    installFetchMock();
    responseQueue = [tokenResponse(), synthesizeResponse()];

    await backend().generate({ text: "Hi", voiceId: "en-US-Neural2-F" });

    const exchange = recordedRequests[0]!;
    expect(exchange.url).toBe("https://oauth2.googleapis.com/token");
    expect(exchange.init.method).toBe("POST");
    expect(exchange.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(exchange.body ?? "");
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = params.get("assertion") ?? "";
    expect(assertion.split(".")).toHaveLength(3);
    const synth = recordedRequests[1]!;
    expect(synth.headers.get("authorization")).toBe("Bearer TEST_ACCESS_TOKEN");
  });

  test("module cache: a second op with the same key does NOT re-exchange", async () => {
    installFetchMock();
    responseQueue = [tokenResponse(), synthesizeResponse(), synthesizeResponse()];

    await backend().generate({ text: "One", voiceId: "en-US-Neural2-F" });
    await backend().generate({ text: "Two", voiceId: "en-US-Neural2-F" });

    // exchange + 2 syntheses — no second exchange despite a NEW backend
    // instance (instances are per-request; the cache is module-level).
    expect(recordedRequests.length).toBe(3);
  });

  test("near-expiry tokens (expires_in below the safety margin) re-exchange", async () => {
    installFetchMock();
    responseQueue = [tokenResponse({ expires_in: 10 }), synthesizeResponse(), tokenResponse({ expires_in: 10 }), synthesizeResponse()];

    await backend().generate({ text: "One", voiceId: "en-US-Neural2-F" });
    await backend().generate({ text: "Two", voiceId: "en-US-Neural2-F" });

    expect(recordedRequests.length).toBe(4);
    expect(recordedRequests.filter((r) => r.url === "https://oauth2.googleapis.com/token").length).toBe(2);
  });

  test("exchange failure (400 invalid_grant) → named error with status + excerpt", async () => {
    installFetchMock();
    responseQueue = [
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    ];

    await expect(backend().generate({ text: "Hi", voiceId: "en-US-Neural2-F" })).rejects.toThrow(
      /HTTP 400.*Invalid JWT Signature/s,
    );
  });

  test("a different service account key gets its own cache entry", async () => {
    installFetchMock();
    const otherJson = JSON.stringify({
      client_email: "other@test-project.iam.gserviceaccount.com",
      private_key: privateKeyPem,
    });
    responseQueue = [tokenResponse(), synthesizeResponse(), tokenResponse({ access_token: "SECOND" }), synthesizeResponse()];

    await backend().generate({ text: "One", voiceId: "en-US-Neural2-F" });
    await backend({ apiKey: otherJson }).generate({ text: "Two", voiceId: "en-US-Neural2-F" });

    expect(recordedRequests.filter((r) => r.url.endsWith("/token")).length).toBe(2);
    expect(lastRequest().headers.get("authorization")).toBe("Bearer SECOND");
  });
});

// ─── generate ────────────────────────────────────────────────────────────────

describe("Google Cloud generate", () => {
  test("posts the documented JSON body to text:synthesize; decodes base64 audioContent", async () => {
    installFetchMock();
    responseQueue = [tokenResponse(), synthesizeResponse(new Uint8Array([1, 2, 3]))];

    const result = await backend().generate({ text: "Hello there", voiceId: "en-US-Neural2-F" });

    const req = lastRequest();
    expect(req.url).toBe("https://texttospeech.googleapis.com/v1/text:synthesize");
    expect(req.init.method).toBe("POST");
    expect(req.headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(req.body!) as Record<string, unknown>;
    expect(body["input"]).toEqual({ text: "Hello there" });
    expect(body["voice"]).toEqual({ languageCode: "en-US", name: "en-US-Neural2-F" });
    expect(body["audioConfig"]).toEqual({ audioEncoding: "MP3" });
    expect(result.mime).toBe("audio/mpeg");
    expect(Array.from(result.audio)).toEqual([1, 2, 3]);
  });

  test("tuning reaches audioConfig; neutral values stay omitted", async () => {
    installFetchMock();
    responseQueue = [tokenResponse(), synthesizeResponse()];

    await backend({ speakingRate: 1.5, pitchSt: -2, volumeGainDb: 4 }).generate({ text: "Hi", voiceId: "en-US-Neural2-F" });

    const body = JSON.parse(lastRequest().body!) as Record<string, unknown>;
    expect(body["audioConfig"]).toEqual({ audioEncoding: "MP3", speakingRate: 1.5, pitch: -2, volumeGainDb: 4 });
  });

  test("hand-edited config values clamp to the documented ranges", async () => {
    installFetchMock();
    responseQueue = [tokenResponse(), synthesizeResponse()];

    await backend({ speakingRate: 99, pitchSt: 50, volumeGainDb: -99 }).generate({ text: "Hi", voiceId: "en-US-Neural2-F" });

    const body = JSON.parse(lastRequest().body!) as Record<string, unknown>;
    expect(body["audioConfig"]).toEqual({ audioEncoding: "MP3", speakingRate: 2, pitch: 20, volumeGainDb: -96 });
  });

  test("guards fail BEFORE any request: empty key, non-JSON key, empty voiceId", async () => {
    installFetchMock();
    await expect(backend({ apiKey: "" }).generate({ text: "Hi", voiceId: "en-US-Neural2-F" })).rejects.toThrow(
      GoogleCloudTtsError,
    );
    await expect(backend({ apiKey: "{oops" }).generate({ text: "Hi", voiceId: "en-US-Neural2-F" })).rejects.toThrow(
      /service-account JSON/,
    );
    await expect(backend().generate({ text: "Hi", voiceId: "  " })).rejects.toThrow(/voiceId/);
    expect(recordedRequests.length).toBe(0);
  });

  test("403 from synthesize surfaces status and body excerpt", async () => {
    installFetchMock();
    responseQueue = [tokenResponse(), jsonResponse({ error: { message: "PERMISSION_DENIED" } }, 403)];

    await expect(backend().generate({ text: "Hi", voiceId: "en-US-Neural2-F" })).rejects.toThrow(
      /HTTP 403.*PERMISSION_DENIED/s,
    );
  });

  test("2xx without audioContent throws a named error", async () => {
    installFetchMock();
    responseQueue = [tokenResponse(), jsonResponse({})];

    await expect(backend().generate({ text: "Hi", voiceId: "en-US-Neural2-F" })).rejects.toThrow(/audioContent/);
  });
});

// ─── listVoices ──────────────────────────────────────────────────────────────

describe("Google Cloud listVoices", () => {
  test("live roster mapping: name · gender, UNSPECIFIED dropped, lang lowercase, sorted", async () => {
    installFetchMock();
    responseQueue = [
      tokenResponse(),
      jsonResponse({
        voices: [
          { name: "en-US-Neural2-F", ssmlGender: "FEMALE", languageCodes: ["en-US"], naturalSampleRateHertz: 24000 },
          { name: "ru-RU-Wavenet-A", ssmlGender: "MALE", languageCodes: ["ru-RU"] },
          { name: "en-US-Studio-O", ssmlGender: "SSML_VOICE_GENDER_UNSPECIFIED", languageCodes: ["en-US"] },
        ],
      }),
    ];

    const voices = await backend().listVoices();

    expect(voices).toEqual([
      { id: "en-US-Neural2-F", label: "en-US-Neural2-F · FEMALE", lang: "en-us" },
      { id: "en-US-Studio-O", label: "en-US-Studio-O", lang: "en-us" },
      { id: "ru-RU-Wavenet-A", label: "ru-RU-Wavenet-A · MALE", lang: "ru-ru" },
    ]);
    const req = lastRequest();
    expect(req.url).toBe("https://texttospeech.googleapis.com/v1/voices");
    expect(req.headers.get("authorization")).toBe("Bearer TEST_ACCESS_TOKEN");
  });

  test("garbage entries are filtered (no name → not a voice)", async () => {
    installFetchMock();
    responseQueue = [tokenResponse(), jsonResponse({ voices: ["not-a-voice", null, { ssmlGender: "FEMALE" }] })];

    const voices = await backend().listVoices();
    expect(voices).toEqual([]);
  });

  test("payload without a voices array throws", async () => {
    installFetchMock();
    responseQueue = [tokenResponse(), jsonResponse({ message: "nope" })];

    await expect(backend().listVoices()).rejects.toThrow(/voices array/);
  });

  test("HTTP failure surfaces status and excerpt", async () => {
    installFetchMock();
    responseQueue = [tokenResponse(), new Response("Forbidden", { status: 401 })];

    await expect(backend().listVoices()).rejects.toThrow(/HTTP 401/);
  });
});

// ─── probe ───────────────────────────────────────────────────────────────────

describe("Google Cloud probe", () => {
  test("missing credential fails without any request", async () => {
    installFetchMock();
    expect((await backend({ apiKey: "" }).probe()).ok).toBe(false);
    expect(recordedRequests.length).toBe(0);
  });

  test("malformed JSON credential fails soft with the parse error", async () => {
    installFetchMock();
    const probe = await backend({ apiKey: "{oops" }).probe();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("service-account JSON");
    expect(recordedRequests.length).toBe(0);
  });

  test("a REAL credential check: bad key fails at the token exchange (400)", async () => {
    installFetchMock();
    responseQueue = [
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." }), { status: 400 }),
    ];

    const probe = await backend().probe();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("400");
  });

  test("successful exchange passes", async () => {
    installFetchMock();
    responseQueue = [tokenResponse()];

    const probe = await backend().probe();
    expect(probe.ok).toBe(true);
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
