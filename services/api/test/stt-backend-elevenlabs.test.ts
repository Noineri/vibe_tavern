/**
 * ElevenLabs STT backend tests (STT_PROVIDER_EXPANSION SPE-5) — mirror of
 * stt-backend-deepgram.test.ts: globalThis.fetch stub capturing the request,
 * pinning the /v1/speech-to-text multipart request shape (xi-api-key auth —
 * NOT Bearer —, FormData with file + model_id + optional language_code) and
 * the {language_code, text, words} reply extraction. Pure-transport pins —
 * no live calls.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { DEFAULT_ELEVENLABS_STT_MODEL, STT_BACKENDS } from "@vibe-tavern/domain";

import {
  ElevenLabsSttConfigError,
  ElevenLabsSttError,
  elevenlabsSttFactory,
  extractSpeechToText,
} from "../src/domain/stt/backends/elevenlabs-stt.js";
import type { SttBackend } from "../src/domain/stt/stt-backend.js";

const TRANSCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const VOICES_URL = "https://api.elevenlabs.io/v1/voices";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchArgs = Parameters<typeof fetch>;

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function captureFetch(handler: () => Response): { captured: () => CapturedRequest | null } {
  let captured: CapturedRequest | null = null;
  globalThis.fetch = mock(async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    captured = {
      url: String(input),
      init: init ?? {},
    };
    return handler();
  });
  return { captured: () => captured };
}

/** Read the captured multipart FormData as a plain record (async — the
 *  FormData API is async for file entries). */
async function readForm(body: unknown): Promise<{ file?: File; fields: Record<string, string> }> {
  if (!(body instanceof FormData)) return { fields: {} };
  const fields: Record<string, string> = {};
  let file: File | undefined;
  for (const [key, value] of body.entries()) {
    if (value instanceof File) file = value;
    else fields[key] = value;
  }
  return { file, fields };
}

/** The documented /v1/speech-to-text success reply. */
function scribeReply(text: string, languageCode = "rus"): unknown {
  return {
    language_code: languageCode,
    language_probability: 0.98,
    text,
    words: [
      { text: "привет", start: 0.1, end: 0.4, type: "word" },
      { text: " ", start: 0.4, end: 0.5, type: "spacing" },
    ],
  };
}

const AUDIO_BYTES = Buffer.from("fake-wav-bytes-16k-mono");

function makeBackend(overrides: Record<string, unknown> = {}): SttBackend {
  return elevenlabsSttFactory({
    model: "scribe_v2-test",
    ...overrides,
  } as never);
}

describe("elevenlabs-stt: config", () => {
  test("missing apiKey → ElevenLabsSttConfigError", () => {
    expect(() => elevenlabsSttFactory({ model: "m" } as never)).toThrow(ElevenLabsSttConfigError);
  });

  test("empty model falls back to DEFAULT_ELEVENLABS_STT_MODEL", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, scribeReply("hi")));
    const backend = makeBackend({ apiKey: "k", model: "" });
    await backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" });
    const form = await readForm(captured()!.init.body);
    expect(form.fields.model_id).toBe(DEFAULT_ELEVENLABS_STT_MODEL);
  });
});

describe("elevenlabs-stt: transcribe", () => {
  test("request shape: speech-to-text URL, xi-api-key header (no Bearer), multipart file+model_id, no language when unset", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, scribeReply("привет, как дела")));
    const backend = makeBackend({ apiKey: "test-key" });

    const result = await backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" });

    const req = captured()!;
    expect(req.url).toBe(TRANSCRIBE_URL);
    const headers = req.init.headers as Record<string, string>;
    // The key travels via the documented xi-api-key header — NOT Bearer.
    expect(headers["xi-api-key"]).toBe("test-key");
    expect(headers["Authorization"]).toBeUndefined();

    const form = await readForm(req.init.body);
    expect(form.fields.model_id).toBe("scribe_v2-test");
    // Omitted language_code = ElevenLabs' own auto-detect (the SPE-R
    // correction: the field is language_code, NOT language_tag).
    expect(form.fields.language_code).toBeUndefined();
    expect(form.file).toBeInstanceOf(File);
    expect(form.file!.name).toBe("audio.wav");
    expect(form.file!.type).toBe("audio/wav");

    expect(result.text).toBe("привет, как дела");
    expect(result.language).toBe("rus");
    expect(result.annotation).toBeUndefined();
  });

  test("language hint rides the language_code field", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, scribeReply("привет")));
    const backend = makeBackend({ apiKey: "k", language: "ru" });
    await backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" });
    const form = await readForm(captured()!.init.body);
    expect(form.fields.language_code).toBe("ru");
  });

  test("mime variants map to honest filenames (webm, mpeg)", async () => {
    const { captured } = captureFetch(() => jsonResponse(200, scribeReply("hi")));
    const backend = makeBackend({ apiKey: "k" });
    await backend.transcribe(AUDIO_BYTES, { mime: "audio/webm;codecs=opus" });
    const form = await readForm(captured()!.init.body);
    expect(form.file!.name).toBe("audio.webm");
    expect(form.file!.type).toBe("audio/webm;codecs=opus");

    const second = captureFetch(() => jsonResponse(200, scribeReply("hi")));
    await backend.transcribe(AUDIO_BYTES, { mime: "audio/mpeg" });
    const form2 = await readForm(second.captured()!.init.body);
    expect(form2.file!.name).toBe("audio.mp3");
  });
});

describe("elevenlabs-stt: errors", () => {
  test("HTTP failure with detail.status/message → ElevenLabsSttError carrying both", async () => {
    captureFetch(() =>
      jsonResponse(401, {
        detail: { status: "invalid_api_key", message: "The provided API key is invalid" },
      }),
    );
    const backend = makeBackend({ apiKey: "bad" });
    let caught: unknown;
    try {
      await backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" });
      expect.unreachable();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ElevenLabsSttError);
    const typed = caught as ElevenLabsSttError;
    expect(typed.status).toBe(401);
    expect(typed.message).toContain("invalid_api_key");
    expect(typed.message).toContain("The provided API key is invalid");
  });

  test("HTTP failure with a bare string detail → status + the string", async () => {
    captureFetch(() => jsonResponse(422, { detail: "the audio could not be processed" }));
    const backend = makeBackend({ apiKey: "k" });
    await expect(backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" })).rejects.toMatchObject({
      name: "ElevenLabsSttError",
      status: 422,
      message: expect.stringContaining("the audio could not be processed"),
    });
  });

  test("transport failure → ElevenLabsSttError (network error wrapper)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const backend = makeBackend({ apiKey: "k" });
    await expect(backend.transcribe(AUDIO_BYTES, { mime: "audio/wav" })).rejects.toMatchObject({
      name: "ElevenLabsSttError",
    });
  });
});

describe("elevenlabs-stt: probe", () => {
  test("GET /v1/voices with xi-api-key (TTS twin's auth check); counts voices", async () => {
    const { captured } = captureFetch(() =>
      jsonResponse(200, { voices: [{ voice_id: "a" }, { voice_id: "b" }] }),
    );
    const backend = makeBackend({ apiKey: "k" });
    const result = await backend.probe();
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("2 voices (account ok)");
    expect(captured()!.url).toBe(VOICES_URL);
    expect((captured()!.init.headers as Record<string, string>)["xi-api-key"]).toBe("k");
  });

  test("HTTP failure → ok:false with the status", async () => {
    captureFetch(() =>
      jsonResponse(401, { detail: { status: "invalid_api_key", message: "bad key" } }),
    );
    const backend = makeBackend({ apiKey: "bad" });
    const result = await backend.probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("401");
  });
});

describe("elevenlabs-stt: extractSpeechToText (defensive containers)", () => {
  test("documented shape maps text + language_code", () => {
    const result = extractSpeechToText(scribeReply("привет"));
    expect(result.text).toBe("привет");
    expect(result.language).toBe("rus");
  });

  test("missing text/language → empty string / absent language, never a throw", () => {
    expect(extractSpeechToText(null)).toEqual({ text: "" });
    expect(extractSpeechToText({})).toEqual({ text: "" });
    expect(extractSpeechToText({ text: "words" })).toEqual({ text: "words" });
    expect(extractSpeechToText({ text: "words", language_code: "  " })).toEqual({ text: "words" });
    expect(extractSpeechToText({ text: 42 })).toEqual({ text: "" });
  });
});

describe("elevenlabs-stt: no listModels (static Scribe roster)", () => {
  test("listModels is deliberately absent — /v1/models is the TTS catalog", async () => {
    const backend = makeBackend({ apiKey: "k" });
    expect(backend.listModels).toBeUndefined();
  });
});

describe("elevenlabs-stt: registry slug", () => {
  test("module-scope registration binds the elevenlabs slug", async () => {
    const { createSttBackend } = await import("../src/domain/stt/stt-registry.js");
    const backend = createSttBackend(STT_BACKENDS.ElevenLabs, { apiKey: "k" } as never);
    expect(typeof backend.transcribe).toBe("function");
  });
});
