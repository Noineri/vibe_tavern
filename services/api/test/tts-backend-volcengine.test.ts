import { afterEach, describe, expect, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import {
  VolcengineTtsBackend,
  buildCustomSpeakerId,
  parseUnidirectionalChunks,
  parseVolcengineConfig,
  volcengineTtsFactory,
} from "../src/domain/tts/backends/volcengine-tts.js";
import { createTtsBackend } from "../src/domain/tts/tts-registry.js";

function backend(config: Record<string, unknown> = {}): VolcengineTtsBackend {
  return volcengineTtsFactory({ apiKey: "vk_key", appId: "app123", modelId: "seed-tts-2.0", ...config }) as VolcengineTtsBackend;
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

/** The unidirectional endpoint answers with CHUNKED JSON LINES: base64
 *  audio chunks (code 0) + the final ok line (code 20000000). */
function unidirectionalResponse(chunkBytes: Uint8Array[] = [new Uint8Array([1, 2]), new Uint8Array([3])]): Response {
  const lines = chunkBytes.map((bytes) => JSON.stringify({ code: 0, message: "", data: Buffer.from(bytes).toString("base64") }));
  lines.push(JSON.stringify({ code: 20000000, message: "ok", data: null, usage: { text_words: 10 } }));
  return new Response(lines.join("\n"), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ─── Registry ────────────────────────────────────────────────────────────────

describe("Volcengine TTS registry", () => {
  test("slug registers through the factory map", () => {
    const created = createTtsBackend(TTS_BACKEND.Volcengine, { apiKey: "k", appId: "a" });
    expect(created instanceof VolcengineTtsBackend).toBe(true);
  });
});

// ─── Config parsing ──────────────────────────────────────────────────────────

describe("Volcengine config parsing", () => {
  test("resource id defaults to seed-tts-2.0; tuning knobs clamp to documented ranges", () => {
    const cfg = parseVolcengineConfig({});
    expect(cfg.resourceId).toBe("seed-tts-2.0");
    expect(cfg.apiKey).toBe("");
    expect(cfg.appId).toBe("");

    const clamped = parseVolcengineConfig({
      speechRate: 500,
      pitch: 99,
      emotionScale: 42,
      emotion: "happy",
    });
    expect(clamped.speechRate).toBe(100);
    expect(clamped.pitch).toBe(12);
    expect(clamped.emotionScale).toBe(5);
    expect(clamped.emotion).toBe("happy");

    const floored = parseVolcengineConfig({ speechRate: -500, pitch: -99, emotionScale: 0 });
    expect(floored.speechRate).toBe(-50);
    expect(floored.pitch).toBe(-12);
    expect(floored.emotionScale).toBe(1);
  });
});

// ─── generate ────────────────────────────────────────────────────────────────

describe("Volcengine generate", () => {
  test("posts to /api/v3/tts/unidirectional with the plain-header auth triple and the documented body", async () => {
    installFetchMock();
    nextResponse = unidirectionalResponse();

    const result = await backend({ speechRate: 20, pitch: 3, emotion: "happy", emotionScale: 5 }).generate({
      text: "你好 world",
      voiceId: "zh_female_shuangkuaisisi_moon_bigtts",
    });

    const req = lastRequest();
    expect(req.url).toBe("https://openspeech.bytedance.com/api/v3/tts/unidirectional");
    expect(req.headers.get("X-Api-App-Id")).toBe("app123");
    expect(req.headers.get("X-Api-Access-Key")).toBe("vk_key");
    expect(req.headers.get("X-Api-Resource-Id")).toBe("seed-tts-2.0");

    const body = req.body as Record<string, unknown>;
    const reqParams = body.req_params as Record<string, unknown>;
    expect(reqParams.text).toBe("你好 world");
    expect(reqParams.speaker).toBe("zh_female_shuangkuaisisi_moon_bigtts");
    const audioParams = reqParams.audio_params as Record<string, unknown>;
    expect(audioParams.format).toBe("mp3");
    expect(audioParams.sample_rate).toBe(24000);
    expect(audioParams.speech_rate).toBe(20);
    expect(audioParams.emotion).toBe("happy");
    expect(audioParams.emotion_scale).toBe(5);
    const additions = reqParams.additions as Record<string, unknown>;
    // Naming inverted in the API: true = parse and STRIP markdown.
    expect(additions.disable_markdown_filter).toBe(true);
    expect(additions.post_process).toEqual({ pitch: 3 });

    // Base64 chunks concatenate; mime is mp3.
    expect(Buffer.isBuffer(result.audio)).toBe(true);
    expect((result.audio as Buffer).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(result.mime).toBe("audio/mpeg");
  });

  test("tuning knobs are OMITTED when unset (server defaults apply)", async () => {
    installFetchMock();
    nextResponse = unidirectionalResponse();

    await backend().generate({ text: "hi", voiceId: "S_x" });

    const body = lastRequest().body as Record<string, unknown>;
    const audioParams = (body.req_params as Record<string, unknown>).audio_params as Record<string, unknown>;
    expect("speech_rate" in audioParams).toBe(false);
    expect("emotion" in audioParams).toBe(false);
    expect("emotion_scale" in audioParams).toBe(false);
    const additions = (body.req_params as Record<string, unknown>).additions as Record<string, unknown>;
    expect("post_process" in additions).toBe(false);
  });

  test("empty voiceId and missing credentials throw before any fetch", async () => {
    installFetchMock();
    let error: unknown;
    try {
      await backend().generate({ text: "hi", voiceId: "  " });
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain("non-empty voiceId");
    expect(recordedRequests).toHaveLength(0);

    error = undefined;
    try {
      await volcengineTtsFactory({}).generate({ text: "hi", voiceId: "v" });
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain("non-empty appId and apiKey");
    expect(recordedRequests).toHaveLength(0);
  });

  test("HTTP failure throws with status + body excerpt", async () => {
    installFetchMock();
    nextResponse = new Response('{"code":45000000,"message":"speaker permission denied"}', { status: 403 });

    let error: unknown;
    try {
      await backend().generate({ text: "hi", voiceId: "v" });
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain("HTTP 403");
    expect((error as Error).message).toContain("speaker permission denied");
  });
});

// ─── Chunk-stream parsing (unit level) ──────────────────────────────────────

describe("parseUnidirectionalChunks", () => {
  test("concatenates base64 data lines and requires the final 20000000 line", () => {
    const result = parseUnidirectionalChunks(
      [
        JSON.stringify({ code: 0, message: "", data: Buffer.from("ab").toString("base64") }),
        JSON.stringify({ code: 0, message: "", data: Buffer.from("cd").toString("base64") }),
        JSON.stringify({ code: 20000000, message: "ok", data: null }),
      ].join("\n"),
    );
    expect((result.audio as Buffer).toString()).toBe("abcd");
    expect(result.mime).toBe("audio/mpeg");
  });

  test("a non-zero non-final code fails with the upstream message", () => {
    const stream = [
      JSON.stringify({ code: 0, message: "", data: "AAAA" }),
      JSON.stringify({ code: 40402003, message: "TTSExceededTextLimit:exceed max limit" }),
    ].join("\n");
    expect(() => parseUnidirectionalChunks(stream)).toThrow("40402003");
    expect(() => parseUnidirectionalChunks(stream)).toThrow("exceed max limit");
  });

  test("missing final ok, empty audio, and garbage lines each fail (garbage after final ok tolerated)", () => {
    const noFinal = JSON.stringify({ code: 0, message: "", data: "AAAA" });
    expect(() => parseUnidirectionalChunks(noFinal)).toThrow("20000000");

    const emptyAudio = JSON.stringify({ code: 20000000, message: "ok", data: null });
    expect(() => parseUnidirectionalChunks(emptyAudio)).toThrow("no audio data");

    const garbage = "not-json-at-all";
    expect(() => parseUnidirectionalChunks(garbage)).toThrow("unparseable chunk");

    const noiseAfterFinal = [
      JSON.stringify({ code: 0, message: "", data: "AAAA" }),
      JSON.stringify({ code: 20000000, message: "ok" }),
      "", // blank lines skipped
      "trailing server noise",
    ].join("\n");
    expect((parseUnidirectionalChunks(noiseAfterFinal).audio as Buffer).length).toBe(3);
  });
});

// ─── listVoices (manual floor) ───────────────────────────────────────────────

describe("Volcengine listVoices", () => {
  test("returns null — no list endpoint exists for the synthesis credentials (owner rule: manual floor, never a static roster)", async () => {
    installFetchMock();
    expect(await backend().listVoices()).toBeNull();
    expect(recordedRequests).toHaveLength(0);
  });
});

// ─── probe ───────────────────────────────────────────────────────────────────

describe("Volcengine probe", () => {
  test("missing credentials fail without a request", async () => {
    const result = await volcengineTtsFactory({}).probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("appId and apiKey");
  });

  test("any structured answer is a pass EXCEPT documented auth-failure messages", async () => {
    installFetchMock();
    // Speaker-not-found is the expected answer for a made-up id — the
    // service answered, the auth layer accepted the credentials.
    nextResponse = new Response('{"code":45001107,"message":"SpeakerID not found"}', { status: 200 });
    let result = await backend().probe();
    expect(result.ok).toBe(true);

    nextResponse = new Response('{"message":"authenticate request: load grant: requested grant not found"}', { status: 401 });
    result = await backend().probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("401");

    nextResponse = new Response('{"message":"get resource id: access denied"}', { status: 403 });
    result = await backend().probe();
    expect(result.ok).toBe(false);
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

// ─── cloneVoice ─────────────────────────────────────────────────────────────

describe("Volcengine cloneVoice", () => {
  test("posts base64 audio to /api/v3/tts/voice_clone on the postpaid custom_speaker_id path", async () => {
    installFetchMock();
    nextResponse = Response.json({
      available_training_times: 15,
      create_time: 1772026663000,
      language: 1,
      speaker_id: "vt-hero-lbx9k2abcd",
      status: 1,
      speaker_status: [],
    });

    const voice = await backend().cloneVoice({
      name: "Hero",
      referenceAudio: Buffer.from("fake-wav-bytes"),
      mimeType: "audio/wav",
    });

    const req = lastRequest();
    expect(req.url).toBe("https://openspeech.bytedance.com/api/v3/tts/voice_clone");
    // Clone/status auth: the app-id/access-key pair (no resource id).
    expect(req.headers.get("X-Api-App-Id")).toBe("app123");
    expect(req.headers.get("X-Api-Access-Key")).toBe("vk_key");
    expect(req.headers.get("X-Api-Resource-Id")).toBeNull();
    expect(req.headers.get("X-Api-Request-Id")).toBeTruthy();

    const body = req.body as Record<string, unknown>;
    expect(body.speaker_id).toBe("custom_speaker_id");
    const audio = body.audio as Record<string, unknown>;
    expect(audio.data).toBe(Buffer.from("fake-wav-bytes").toString("base64"));
    expect(audio.format).toBe("wav");
    // The custom id honors the documented shape.
    const customId = body.custom_speaker_id as string;
    expect(customId.startsWith("vt-")).toBe(true);
    expect(customId.length).toBeGreaterThanOrEqual(8);

    // Async training: status 1 rides in the label; the wire id is the
    // echoed speaker_id (our custom id).
    expect(voice.id).toBe("vt-hero-lbx9k2abcd");
    expect(voice.label).toContain("training");
    expect(voice.label).toContain("Hero");
    expect(voice.lang).toBe("clone");
  });

  test("mime → audio.format table (wav/ogg/m4a/aac; mp3 fallback)", async () => {
    installFetchMock();
    nextResponse = Response.json({ speaker_id: "vt-x", status: 2 });

    await backend().cloneVoice({ name: "A", referenceAudio: Buffer.from("x"), mimeType: "audio/ogg" });
    expect(((lastRequest().body as Record<string, unknown>).audio as Record<string, unknown>).format).toBe("ogg");

    await backend().cloneVoice({ name: "A", referenceAudio: Buffer.from("x"), mimeType: "audio/x-m4a" });
    expect(((lastRequest().body as Record<string, unknown>).audio as Record<string, unknown>).format).toBe("m4a");

    await backend().cloneVoice({ name: "A", referenceAudio: Buffer.from("x"), mimeType: "audio/aac" });
    expect(((lastRequest().body as Record<string, unknown>).audio as Record<string, unknown>).format).toBe("aac");

    await backend().cloneVoice({ name: "A", referenceAudio: Buffer.from("x"), mimeType: "audio/mpeg" });
    expect(((lastRequest().body as Record<string, unknown>).audio as Record<string, unknown>).format).toBe("mp3");
  });

  test("HTTP failure surfaces with status + excerpt; response without echo falls back to the sent id", async () => {
    installFetchMock();
    nextResponse = new Response('{"code":45001104,"message":"voiceprint check failed"}', { status: 400 });
    let error: unknown;
    try {
      await backend().cloneVoice({ name: "Hero", referenceAudio: Buffer.from("x"), mimeType: "audio/wav" });
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain("HTTP 400");
    expect((error as Error).message).toContain("voiceprint");

    // Degraded JSON (no speaker_id echo): the id we generated is the
    // authoritative wire id for a postpaid clone.
    nextResponse = Response.json({ status: 1 });
    const voice = await backend().cloneVoice({ name: "Hero", referenceAudio: Buffer.from("x"), mimeType: "audio/wav" });
    const body = lastRequest().body as Record<string, unknown>;
    expect(voice.id).toBe(body.custom_speaker_id);
  });
});

// ─── buildCustomSpeakerId (documented rule properties) ─────────────────────

describe("buildCustomSpeakerId", () => {
  test("vt- prefix, letter start, legal charset, length bounds, uniqueness across calls", () => {
    for (const name of ["Hero", "Герой памяти", "", "a".repeat(300), "weird !! name"]) {
      const id = buildCustomSpeakerId(name);
      expect(id.length).toBeGreaterThanOrEqual(8);
      expect(id.length).toBeLessThanOrEqual(256);
      expect(id.startsWith("vt-")).toBe(true);
      expect(/^[a-z][a-z0-9_-]*[a-z0-9]$|^[a-z][a-z0-9]{7,}$/.test(id)).toBe(true);
      expect(id).not.toMatch(/[-_]$/);
      // No official-pattern collision: never starts with the reserved
      // prefixes (S_/ICL_/MIX_/DiT_/BV/<lang>_) and never ends bigtts.
      expect(id.startsWith("vt-")).toBe(true);
      expect(id.endsWith("bigtts")).toBe(false);
    }
    expect(buildCustomSpeakerId("Hero")).not.toBe(buildCustomSpeakerId("Hero"));
  });
});

// ─── capabilities + dispose ─────────────────────────────────────────────────

describe("Volcengine capabilities + dispose", () => {
  test("static clone capabilities mirror the documented sample limits", async () => {
    const caps = backend().capabilities();
    expect(caps.supportsCloning).toBe(true);
    expect(caps.formats).toEqual(["wav", "mp3", "ogg", "m4a", "aac"]);
    expect(caps.maxSizeMb).toBe(10);
    await backend().dispose();
  });
});
