import { afterEach, describe, expect, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";

import {
  MinimaxTtsBackend,
  buildCloneVoiceId,
  minimaxTtsFactory,
  parseGetVoiceResponse,
} from "../src/domain/tts/backends/minimax-tts.js";
import { createTtsBackend } from "../src/domain/tts/tts-registry.js";

function backend(config: Record<string, unknown> = {}): MinimaxTtsBackend {
  return minimaxTtsFactory({ apiKey: "mm_key", ...config }) as MinimaxTtsBackend;
}

// ─── fetch mock helpers (house pattern — see tts-backend-cartesia.test.ts) ─

interface RecordedRequest {
  url: string;
  init: RequestInit;
  body: unknown;
  form: FormData | null;
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
    let form: FormData | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body instanceof FormData) {
      form = init.body;
      body = "<form-data>";
    }
    recordedRequests.push({ url, init: init ?? {}, body, form, headers });
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

// The t2a endpoint answers with JSON whose data.audio is HEX-encoded mp3.
function synthesisResponse(bytes: Uint8Array = new Uint8Array([1, 2, 3])): Response {
  return Response.json({
    data: { audio: Buffer.from(bytes).toString("hex"), status: 2 },
    extra_info: { audio_format: "mp3", audio_sample_rate: 32000, usage_characters: 6 },
    trace_id: "trace-1",
    base_resp: { status_code: 0, status_msg: "success" },
  });
}

// ─── generate (POST /v1/t2a_v2) ──────────────────────────────────────────────

describe("MinimaxTtsBackend.generate", () => {
  test("sends the documented body shape with Bearer auth; decodes HEX audio", async () => {
    installFetchMock();
    nextResponse = synthesisResponse(new Uint8Array([7, 8, 9]));

    const result = await backend().generate({ text: "Hello there.", voiceId: "English_expressive_narrator" });

    const req = lastRequest();
    expect(req.url).toBe("https://api.minimax.io/v1/t2a_v2");
    expect(req.init.method).toBe("POST");
    expect(req.headers.get("Authorization")).toBe("Bearer mm_key");
    expect(req.headers.get("Content-Type")).toBe("application/json");
    expect(req.body).toEqual({
      model: "speech-2.8-hd",
      text: "Hello there.",
      stream: false,
      output_format: "hex",
      voice_setting: { voice_id: "English_expressive_narrator" },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    });
    expect(Buffer.from(result.audio)).toEqual(Buffer.from([7, 8, 9]));
    expect(result.mime).toBe("audio/mpeg");
  });

  test("speed rides inside voice_setting, clamped to the documented [0.5, 2]", async () => {
    installFetchMock();
    nextResponse = synthesisResponse();

    await backend({ speed: 1.5 }).generate({ text: "hi", voiceId: "v" });
    expect((lastRequest().body as { voice_setting: Record<string, unknown> }).voice_setting.speed).toBe(1.5);

    await backend({ speed: 9 }).generate({ text: "hi", voiceId: "v" });
    expect((lastRequest().body as { voice_setting: Record<string, unknown> }).voice_setting.speed).toBe(2);

    await backend({ speed: 0.1 }).generate({ text: "hi", voiceId: "v" });
    expect((lastRequest().body as { voice_setting: Record<string, unknown> }).voice_setting.speed).toBe(0.5);

    await backend().generate({ text: "hi", voiceId: "v" });
    expect((lastRequest().body as { voice_setting: Record<string, unknown> }).voice_setting.speed).toBeUndefined();
  });

  test("sends a configured model verbatim", async () => {
    installFetchMock();
    nextResponse = synthesisResponse();

    await backend({ modelId: "speech-2.6-turbo" }).generate({ text: "hi", voiceId: "v" });
    expect((lastRequest().body as Record<string, unknown>).model).toBe("speech-2.6-turbo");
  });

  test("honors base_resp failures riding inside HTTP 200 (MiniMax's in-band status)", async () => {
    installFetchMock();
    nextResponse = Response.json({
      base_resp: { status_code: 1004, status_msg: "invalid api key" },
    });

    await expect(backend().generate({ text: "hi", voiceId: "v" })).rejects.toThrow(
      /MiniMax text-to-speech failed with status 1004.*invalid api key/,
    );
  });

  test("throws with an upstream excerpt on a non-2xx response", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ message: "forbidden" }), { status: 403 });

    await expect(backend().generate({ text: "hi", voiceId: "v" })).rejects.toThrow(
      /MiniMax text-to-speech failed with HTTP 403.*forbidden/,
    );
  });

  test("throws when data.audio is missing", async () => {
    installFetchMock();
    nextResponse = Response.json({ data: { status: 2 }, base_resp: { status_code: 0, status_msg: "success" } });
    await expect(backend().generate({ text: "hi", voiceId: "v" })).rejects.toThrow(/missing data\.audio/);
  });

  test("requires a non-empty apiKey and voiceId", async () => {
    installFetchMock();
    await expect(minimaxTtsFactory({}).generate({ text: "hi", voiceId: "v" })).rejects.toThrow(
      /requires a non-empty apiKey/,
    );
    await expect(backend().generate({ text: "hi", voiceId: "  " })).rejects.toThrow(/non-empty voiceId/);
    expect(recordedRequests.length).toBe(0);
  });
});

// ─── listVoices (POST /v1/get_voice) ─────────────────────────────────────────

describe("MinimaxTtsBackend.listVoices", () => {
  test("asks for voice_type all and merges system + clone sections", async () => {
    installFetchMock();
    nextResponse = Response.json({
      system_voice: [
        {
          voice_id: "Chinese (Mandarin)_Reliable_Executive",
          description: ["A steady and reliable male executive voice in standard Mandarin."],
          voice_name: "Steady Executive",
          created_time: "1970-01-01",
        },
        { voice_id: "English_expressive_narrator", description: [], voice_name: "Expressive Narrator", created_time: "1970-01-01" },
        { noVoiceId: true }, // filtered by the parse guard
      ],
      voice_cloning: [{ voice_id: "vt-hero-lx2", created_time: "2026-08-31" }],
      voice_generation: [],
      base_resp: { status_code: 0, status_msg: "success" },
    });

    const voices = await backend().listVoices();

    expect(voices).toEqual([
      {
        id: "Chinese (Mandarin)_Reliable_Executive",
        label: "Steady Executive · A steady and reliable male executive voice in standard Mandarin.",
        lang: "multi",
      },
      { id: "English_expressive_narrator", label: "Expressive Narrator", lang: "multi" },
      { id: "vt-hero-lx2", label: "vt-hero-lx2 · mine", lang: "multi" },
    ]);

    const req = lastRequest();
    expect(req.url).toBe("https://api.minimax.io/v1/get_voice");
    expect(req.body).toEqual({ voice_type: "all" });
    expect(req.headers.get("Authorization")).toBe("Bearer mm_key");
  });

  test("throws on a malformed payload", async () => {
    installFetchMock();
    nextResponse = new Response("not json", { status: 200 });
    await expect(backend().listVoices()).rejects.toThrow();
  });
});

describe("parseGetVoiceResponse", () => {
  test("guards the unknown boundary (missing sections degrade to empty lists)", () => {
    expect(parseGetVoiceResponse({})).toEqual([]);
    expect(parseGetVoiceResponse({ system_voice: "nope" })).toEqual([]);
    expect(parseGetVoiceResponse({ system_voice: [{ voice_id: "a" }] })).toEqual([
      { id: "a", label: "a", lang: "multi" },
    ]);
  });
});

// ─── listModels (static documented catalog — no network) ─────────────────────

describe("MinimaxTtsBackend.listModels", () => {
  test("serves the static documented catalog without touching the network", async () => {
    installFetchMock();
    const models = await backend().listModels();
    expect(models.map((m) => m.id)).toEqual([
      "speech-2.8-hd",
      "speech-2.8-turbo",
      "speech-2.6-hd",
      "speech-2.6-turbo",
      "speech-02-hd",
      "speech-02-turbo",
      "speech-01-hd",
      "speech-01-turbo",
    ]);
    expect(recordedRequests.length).toBe(0);
  });
});

// ─── probe (POST /v1/get_voice — cheapest authenticated call) ────────────────

describe("MinimaxTtsBackend.probe", () => {
  test("reports ok on success", async () => {
    installFetchMock();
    nextResponse = Response.json({ voice_cloning: [], base_resp: { status_code: 0, status_msg: "success" } });

    const result = await backend().probe();

    expect(result.ok).toBe(true);
    expect(lastRequest().body).toEqual({ voice_type: "voice_cloning" });
  });

  test("honors in-band base_resp failures too", async () => {
    installFetchMock();
    nextResponse = Response.json({ base_resp: { status_code: 1004, status_msg: "invalid api key" } });
    const failed = await backend().probe();
    expect(failed.ok).toBe(false);
    expect(failed.detail).toMatch(/status 1004.*invalid api key/);
  });

  test("surfaces HTTP failures and missing keys without throwing", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
    const failed = await backend().probe();
    expect(failed.ok).toBe(false);
    expect(failed.detail).toMatch(/401.*unauthorized/);

    const noKey = await minimaxTtsFactory({}).probe();
    expect(noKey).toEqual({ ok: false, detail: "apiKey is required for MiniMax." });
  });
});

// ─── cloneVoice (two-step: /v1/files/upload → /v1/voice_clone) ───────────────

describe("MinimaxTtsBackend.cloneVoice", () => {
  test("uploads the sample first, then clones with a generated voice_id", async () => {
    installFetchMock();
    let call = 0;
    nextResponse = () => {
      call++;
      if (call === 1) {
        return Response.json({
          file: { file_id: 123456789, bytes: 3, created_at: 1700469398, filename: "clip.mp3", purpose: "voice_clone" },
          base_resp: { status_code: 0, status_msg: "success" },
        });
      }
      return Response.json({
        input_sensitive: false,
        demo_audio: "",
        base_resp: { status_code: 0, status_msg: "success" },
      });
    };

    const voice = await backend().cloneVoice({
      name: "Hero Voice",
      referenceAudio: Buffer.from([9, 9, 9]),
      mimeType: "audio/mp3",
    });

    // Step 1 — multipart upload.
    const upload = recordedRequests[0]!;
    expect(upload.url).toBe("https://api.minimax.io/v1/files/upload");
    expect(upload.headers.get("Authorization")).toBe("Bearer mm_key");
    // No Content-Type — fetch derives the multipart boundary itself.
    expect(upload.headers.get("Content-Type")).toBeNull();
    expect(upload.form).toBeInstanceOf(FormData);
    expect(upload.form!.get("purpose")).toBe("voice_clone");
    const file = upload.form!.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("clip.mp3");

    // Step 2 — JSON clone referencing the uploaded file_id.
    const clone = recordedRequests[1]!;
    expect(clone.url).toBe("https://api.minimax.io/v1/voice_clone");
    expect(clone.body).toEqual({ file_id: 123456789, voice_id: voice.id });

    // The returned record points at OUR chosen id (rules-checked in the
    // buildCloneVoiceId suite; the random tail differs per call).
    expect(voice.id).toMatch(/^vt-hero-voice-/);
    expect(voice.label).toBe("Hero Voice · mine");
  });

  test("maps the mime type to the documented attachment formats", async () => {
    installFetchMock();
    let call = 0;
    nextResponse = () => {
      call++;
      if (call % 2 === 1) {
        return Response.json({
          file: { file_id: 1, bytes: 1, created_at: 1, filename: "c", purpose: "voice_clone" },
          base_resp: { status_code: 0, status_msg: "success" },
        });
      }
      return Response.json({ base_resp: { status_code: 0, status_msg: "success" } });
    };

    await backend().cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/x-m4a" });
    expect((recordedRequests[0]!.form!.get("file") as File).name).toBe("clip.m4a");

    await backend().cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/wav" });
    expect((recordedRequests[2]!.form!.get("file") as File).name).toBe("clip.wav");
  });

  test("surfaces step-1 upload failures without calling the clone endpoint", async () => {
    installFetchMock();
    nextResponse = new Response(JSON.stringify({ message: "file too large" }), { status: 400 });

    await expect(
      backend().cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/mp3" }),
    ).rejects.toThrow(/MiniMax file upload failed with HTTP 400.*file too large/);
    expect(recordedRequests.length).toBe(1);
  });

  test("surfaces step-2 clone failures with the in-band status", async () => {
    installFetchMock();
    let call = 0;
    nextResponse = () => {
      call++;
      if (call === 1) {
        return Response.json({
          file: { file_id: 7, bytes: 1, created_at: 1, filename: "c", purpose: "voice_clone" },
          base_resp: { status_code: 0, status_msg: "success" },
        });
      }
      return Response.json({ base_resp: { status_code: 2013, status_msg: "voice_id already exists" } });
    };

    await expect(
      backend().cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/mp3" }),
    ).rejects.toThrow(/MiniMax voice clone failed with status 2013.*voice_id already exists/);
  });

  test("throws when the upload response carries no file_id", async () => {
    installFetchMock();
    nextResponse = Response.json({ base_resp: { status_code: 0, status_msg: "success" } });
    await expect(
      backend().cloneVoice({ name: "N", referenceAudio: Buffer.from([1]), mimeType: "audio/mp3" }),
    ).rejects.toThrow(/missing file\.file_id/);
  });
});

describe("buildCloneVoiceId", () => {
  test("honors every documented voice_id rule", () => {
    for (const name of ["Hero Voice", "Мой голос", "a", "with spaces  and !! symbols", "x".repeat(300)]) {
      const id = buildCloneVoiceId(name);
      expect(id.length).toBeGreaterThanOrEqual(8);
      expect(id.length).toBeLessThanOrEqual(256);
      expect(/^[a-z]/.test(id)).toBe(true); // starts with an English letter
      expect(/^[a-z0-9_-]+$/.test(id)).toBe(true); // letters/digits/-/_ only
      expect(!/[-_]$/.test(id)).toBe(true); // never ends with - or _
    }
    // Non-ASCII names still produce a stable prefixed slug shape.
    expect(buildCloneVoiceId("Hero Voice")).toMatch(/^vt-hero-voice-/);
    expect(buildCloneVoiceId("Мой голос")).toMatch(/^vt-/);
  });
});

// ─── capabilities / registry wiring ───────────────────────────────────────────

describe("MinimaxTtsBackend.capabilities", () => {
  test("declares static cloning with the documented upload hints", () => {
    const caps = backend().capabilities();
    expect(caps.supportsCloning).toBe(true);
    expect(caps.formats).toEqual(["mp3", "m4a", "wav"]);
    expect(caps.maxSizeMb).toBe(20);
  });
});

describe("registry wiring (minimax)", () => {
  test("module import registers the factory under the minimax slug", () => {
    const created = createTtsBackend(TTS_BACKEND.MiniMax, { apiKey: "k" });
    expect(created).toBeInstanceOf(MinimaxTtsBackend);
    expect(created.capabilities().supportsCloning).toBe(true);
  });
});
