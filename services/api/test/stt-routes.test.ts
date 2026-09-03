/**
 * STT routes tests (STT_PLAN ST-5b) — mirror of tts-routes.test.ts: real
 * in-memory database + real adapter + real route, only the upstream fetch is
 * mocked (the openai-stt adapter reads globalThis.fetch). Covers CRUD, the
 * multipart transcription path, key resolution precedence (own key >
 * provider auto-match > TTS-profile auto-match) and the error mappings.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { createDb } from "@vibe-tavern/db";
import { ProviderStore, SttStore, TtsStore } from "@vibe-tavern/db";

import { createSttRoutes } from "../src/api/routes/stt.js";
import { SttAdapter, __setSttDiscoveryFetchForTests } from "../src/api/adapters/stt-adapter.js";

const fixedClock = { now: () => "2026-09-03T00:00:00.000Z" };

function makeIdGen() {
  let counter = 0;
  return { next: (prefix: string) => `${prefix}_test_${++counter}` };
}

/** openai-compat STT profile config used across the CRUD + transcribe tests. */
const OPENAI_COMPAT_CONFIG = {
  endpoint: "http://localhost:8000/v1",
  model: "whisper-1",
};

type FetchArgs = Parameters<typeof fetch>;

const originalFetch = globalThis.fetch;

async function makeApp() {
  const db = await createDb(":memory:");
  const stt = new SttStore(db, { clock: fixedClock, idGenerator: makeIdGen() });
  const providers = new ProviderStore(db, { clock: fixedClock, idGenerator: makeIdGen() });
  const tts = new TtsStore(db, { clock: fixedClock, idGenerator: makeIdGen() });
  const adapter = new SttAdapter({ stt, providers, tts });
  const app = createSttRoutes(adapter);
  return { app, stt, providers, tts, db };
}

function multipartTranscribe(profileId: string, extra?: { language?: string }): RequestInit {
  const form = new FormData();
  form.append("audio", new File([new Uint8Array([1, 2, 3])], "sample.mp3", { type: "audio/mpeg" }));
  form.append("profileId", profileId);
  if (extra?.language !== undefined) form.append("language", extra.language);
  return { method: "POST", body: form };
}

// THE REGISTRY IS PROCESS-GLOBAL (mock.module gotcha applies to bun:test):
// stt-registry.test.ts runs `__resetSttRegistryForTests()` in the SAME
// process, wiping the openai-compat factory that stt-adapter.ts registers at
// import time. Re-register the real factory explicitly in beforeEach so this
// file is order-independent (same pattern as the TTS routes tests, which
// re-register their stubs).

import { openAiCompatSttFactory } from "../src/domain/stt/backends/openai-stt.js";
import { geminiSttFactory } from "../src/domain/stt/backends/gemini-stt.js";
import {
  __resetSttRegistryForTests,
  registerSttBackend,
} from "../src/domain/stt/stt-registry.js";
import { STT_BACKENDS } from "@vibe-tavern/domain";

beforeEach(() => {
  __resetSttRegistryForTests();
  registerSttBackend(STT_BACKENDS.OpenAiCompat, openAiCompatSttFactory);
  registerSttBackend(STT_BACKENDS.Gemini, geminiSttFactory);
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("STT routes — local discovery (server-side, ST-8)", () => {
  test("GET /api/stt/discover → probe outcomes; whisper server recognized", async () => {
    __setSttDiscoveryFetchForTests(async (input: string) => {
      if (input.endsWith("/v1/models")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "Systran/faster-whisper-base" }] }),
        };
      }
      // GET on the POST-only transcriptions route → 405 (route exists).
      if (input.endsWith("/v1/audio/transcriptions")) {
        return { ok: false, status: 405, json: async () => ({}) };
      }
      throw new TypeError("refused");
    });
    const { app } = await makeApp();
    const res = await app.request("/api/stt/discover");
    expect(res.status).toBe(200);
    const outcomes = (await res.json()) as Array<{
      port: number;
      status: string;
      server?: { kind: string; baseUrl: string; modelIds: string[]; voiceIds: string[] };
    }>;
    const found = outcomes.find((o) => o.status === "found");
    // 8880 is the first port in the shared probe list, so it matches first.
    expect(found?.port).toBe(8880);
    expect(found?.server?.kind).toBe("openai-compatible");
    expect(found?.server?.baseUrl).toBe("http://127.0.0.1:8880");
    expect(found?.server?.modelIds).toEqual(["Systran/faster-whisper-base"]);
    expect(found?.server?.voiceIds).toEqual([]);
    __setSttDiscoveryFetchForTests(null);
  });

  test("all ports refused → 200 with refused outcomes (no 500, no throw)", async () => {
    __setSttDiscoveryFetchForTests(async () => {
      throw new TypeError("refused");
    });
    const { app } = await makeApp();
    const res = await app.request("/api/stt/discover");
    expect(res.status).toBe(200);
    const outcomes = (await res.json()) as Array<{ status: string }>;
    expect(outcomes.length).toBe(7);
    expect(outcomes.every((o) => o.status === "refused")).toBe(true);
    __setSttDiscoveryFetchForTests(null);
  });
});

describe("STT routes — CRUD", () => {
  test("POST /api/stt/profiles → 201, GET :id round-trip, GET all", async () => {
    const { app } = await makeApp();

    const createdRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Whisper — base",
        backend: "whisper-browser",
        config: { model: "onnx-community/whisper-base" },
      }),
    });
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as { id: string; name: string };
    expect(created.name).toBe("Whisper — base");
    expect((created as { hasStoredApiKey: boolean }).hasStoredApiKey).toBe(false);

    const getRes = await app.request(`/api/stt/profiles/${created.id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { id: string };
    expect(fetched.id).toBe(created.id);

    const allRes = await app.request("/api/stt/profiles/all");
    expect(allRes.status).toBe(200);
    const all = (await allRes.json()) as unknown[];
    expect(all.length).toBe(1);
  });

  test("PATCH unknown id → 404; DELETE → ok:true", async () => {
    const { app } = await makeApp();

    const patchRes = await app.request("/api/stt/profiles/missing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(patchRes.status).toBe(404);

    const delRes = await app.request("/api/stt/profiles/missing", { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { ok: boolean };
    expect(delBody.ok).toBe(true);
  });

  test("PUT default → pointer moves", async () => {
    const { app } = await makeApp();

    const aRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "A", backend: "whisper-browser", config: { model: "m" }, isDefault: true }),
    });
    const a = (await aRes.json()) as { id: string };
    const bRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "B", backend: "whisper-browser", config: { model: "m" } }),
    });
    const b = (await bRes.json()) as { id: string };

    const putRes = await app.request(`/api/stt/profiles/${b.id}/default`, { method: "PUT" });
    expect(putRes.status).toBe(200);

    const getA = (await (await app.request(`/api/stt/profiles/${a.id}`)).json()) as { isDefault: boolean };
    const getB = (await (await app.request(`/api/stt/profiles/${b.id}`)).json()) as { isDefault: boolean };
    expect(getA.isDefault).toBe(false);
    expect(getB.isDefault).toBe(true);
  });

  test("apiKey is write-only: create with key → hasStoredApiKey true, config never carries it", async () => {
    const { app } = await makeApp();

    const createdRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Cloud",
        backend: "openai-compat",
        config: OPENAI_COMPAT_CONFIG,
        apiKey: "sk-secret",
      }),
    });
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as { hasStoredApiKey: boolean; config: Record<string, unknown> };
    expect(created.hasStoredApiKey).toBe(true);
    expect("apiKey" in created.config).toBe(false);
    const text = JSON.stringify(created);
    expect(text).not.toContain("sk-secret");
  });
});

describe("STT routes — transcription", () => {
  test("happy path: multipart in, text out; Bearer + URL join asserted", async () => {
    const { app } = await makeApp();

    const profileRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Cloud",
        backend: "openai-compat",
        config: OPENAI_COMPAT_CONFIG,
        apiKey: "sk-own",
      }),
    });
    const profile = (await profileRes.json()) as { id: string };

    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock(async (input: FetchArgs[0], init?: FetchArgs[1]) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ text: "hello world", language: "en" }), { status: 200 });
    });

    const res = await app.request("/api/stt/transcribe", multipartTranscribe(profile.id, { language: "ru" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; language?: string };
    expect(body.text).toBe("hello world");
    expect(body.language).toBe("en");

    // URL join: base endpoint + /audio/transcriptions.
    expect(capturedUrl).toBe("http://localhost:8000/v1/audio/transcriptions");
    // Bearer from the OWN key.
    const auth = (capturedInit?.headers as Record<string, string> | undefined)?.["Authorization"];
    expect(auth).toBe("Bearer sk-own");
    // Multipart carries file + model + language + response_format.
    const form = capturedInit?.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("language")).toBe("ru");
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file") as File;
    expect(file.type).toBe("audio/mpeg");
  });

  test("unknown profile → 404", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/stt/transcribe", multipartTranscribe("missing"));
    expect(res.status).toBe(404);
  });

  test("whisper-browser profile → 400 (runs client-side)", async () => {
    const { app } = await makeApp();
    const profileRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Local", backend: "whisper-browser", config: { model: "m" } }),
    });
    const profile = (await profileRes.json()) as { id: string };
    const res = await app.request("/api/stt/transcribe", multipartTranscribe(profile.id));
    expect(res.status).toBe(400);
  });

  test("missing audio / missing profileId → 400", async () => {
    const { app } = await makeApp();
    const noAudio = await app.request("/api/stt/transcribe", {
      method: "POST",
      body: new FormData(),
    });
    expect(noAudio.status).toBe(400);

    const noProfile = await app.request("/api/stt/transcribe", {
      method: "POST",
      body: (() => {
        const form = new FormData();
        form.append("audio", new File([new Uint8Array([1])], "sample.mp3", { type: "audio/mpeg" }));
        return form;
      })(),
    });
    expect(noProfile.status).toBe(400);
  });

  test("non-audio mime → 400", async () => {
    const { app } = await makeApp();
    const profileRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Cloud", backend: "openai-compat", config: OPENAI_COMPAT_CONFIG }),
    });
    const profile = (await profileRes.json()) as { id: string };

    const form = new FormData();
    form.append("audio", new File([new Uint8Array([1])], "x.json", { type: "application/json" }));
    form.append("profileId", profile.id);
    const res = await app.request("/api/stt/transcribe", { method: "POST", body: form });
    expect(res.status).toBe(400);
  });

  test("upstream 500 → 502 with a normalized message", async () => {
    const { app } = await makeApp();
    const profileRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Cloud", backend: "openai-compat", config: OPENAI_COMPAT_CONFIG }),
    });
    const profile = (await profileRes.json()) as { id: string };

    globalThis.fetch = mock(async () => new Response("boom", { status: 500 }));
    const res = await app.request("/api/stt/transcribe", multipartTranscribe(profile.id));
    expect(res.status).toBe(502);
  });
});

describe("STT routes — auto-key resolution", () => {
  test("own key wins over any auto-match", async () => {
    const { app, providers } = await makeApp();
    await providers.create({
      name: "Local Whisper",
      providerPreset: "custom",
      endpoint: "http://localhost:8000/v1",
      apiKey: "sk-provider",
      isDefault: true,
    } as never);

    const profileRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Cloud",
        backend: "openai-compat",
        config: OPENAI_COMPAT_CONFIG,
        apiKey: "sk-own",
      }),
    });
    const profile = (await profileRes.json()) as { id: string };

    globalThis.fetch = mock(async (_input, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      expect(auth).toBe("Bearer sk-own");
      return new Response(JSON.stringify({ text: "hi" }), { status: 200 });
    });
    const res = await app.request("/api/stt/transcribe", multipartTranscribe(profile.id));
    expect(res.status).toBe(200);
  });

  test("no own key: endpoint-matching LLM provider key is used", async () => {
    const { app, providers } = await makeApp();
    await providers.create({
      name: "Local Whisper",
      providerPreset: "custom",
      endpoint: "http://localhost:8000/v1",
      apiKey: "sk-provider",
      isDefault: true,
    } as never);

    const profileRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Cloud", backend: "openai-compat", config: OPENAI_COMPAT_CONFIG }),
    });
    const profile = (await profileRes.json()) as { id: string };

    // The profile wire record should hint at the auto-match.
    const fetched = (await (await app.request(`/api/stt/profiles/${profile.id}`)).json()) as {
      autoKeyProviderName: string | null;
    };
    expect(fetched.autoKeyProviderName).toBe("Local Whisper");

    globalThis.fetch = mock(async (_input, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      expect(auth).toBe("Bearer sk-provider");
      return new Response(JSON.stringify({ text: "hi" }), { status: 200 });
    });
    const res = await app.request("/api/stt/transcribe", multipartTranscribe(profile.id));
    expect(res.status).toBe(200);
  });

  test("no own key, no provider match: endpoint-matching openai-compat TTS profile key is used", async () => {
    const { app, tts } = await makeApp();
    const ttsProfile = await tts.create({
      name: "TTS Cloud",
      backend: "openai-compatible" as never,
      config: { endpoint: "http://localhost:8000/v1" },
      apiKey: "sk-tts",
    } as never);

    const profileRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "STT Cloud", backend: "openai-compat", config: OPENAI_COMPAT_CONFIG }),
    });
    const profile = (await profileRes.json()) as { id: string };

    globalThis.fetch = mock(async (_input, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      expect(auth).toBe("Bearer sk-tts");
      return new Response(JSON.stringify({ text: "hi" }), { status: 200 });
    });
    const res = await app.request("/api/stt/transcribe", multipartTranscribe(profile.id));
    expect(res.status).toBe(200);
    expect(ttsProfile.id).toBeTruthy();
  });

  test("no match anywhere: no Authorization header (keyless local server)", async () => {
    const { app } = await makeApp();
    const profileRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Local", backend: "openai-compat", config: OPENAI_COMPAT_CONFIG }),
    });
    const profile = (await profileRes.json()) as { id: string };

    globalThis.fetch = mock(async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"] ?? headers["authorization"]).toBeUndefined();
      return new Response(JSON.stringify({ text: "hi" }), { status: 200 });
    });
    const res = await app.request("/api/stt/transcribe", multipartTranscribe(profile.id));
    expect(res.status).toBe(200);
  });
});

describe("STT routes — Gemini backend (ST-7)", () => {
  /** Interactions reply the backend parses (steps → model_output → text). */
  function interactionsJsonReply(payload: string): Response {
    return new Response(
      JSON.stringify({ steps: [{ type: "model_output", content: [{ type: "text", text: payload }] }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  test("vendor auto-key: a Gemini-API-host LLM provider key rides x-goog-api-key; hint names it", async () => {
    const { app, providers } = await makeApp();
    await providers.create({
      name: "Google LLM",
      providerPreset: "google",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "g-llm-key",
      isDefault: true,
    } as never);

    const profileRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Gemini STT", backend: "gemini", config: { model: "gemini-test" } }),
    });
    expect(profileRes.status).toBe(201);
    const profile = (await profileRes.json()) as { id: string; autoKeyProviderName: string | null };
    expect(profile.autoKeyProviderName).toBe("Google LLM");

    globalThis.fetch = mock(async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["x-goog-api-key"]).toBe("g-llm-key");
      expect(headers.Authorization).toBeUndefined();
      return interactionsJsonReply("hello from gemini");
    });
    const res = await app.request("/api/stt/transcribe", multipartTranscribe(profile.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; annotation?: string };
    expect(body.text).toBe("hello from gemini");
  });

  test("no provider: a gemini TTS profile key is reused (Google TTS credential → Google STT ready)", async () => {
    const { app, tts } = await makeApp();
    await tts.create({
      name: "Gemini TTS",
      backend: "gemini" as never,
      config: {},
      apiKey: "g-tts-key",
    } as never);

    const profileRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Gemini STT", backend: "gemini", config: { model: "gemini-test" } }),
    });
    const profile = (await profileRes.json()) as { id: string; autoKeyProviderName: string | null };
    expect(profile.autoKeyProviderName).toBe("Gemini TTS");

    globalThis.fetch = mock(async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["x-goog-api-key"]).toBe("g-tts-key");
      return interactionsJsonReply("hi");
    });
    const res = await app.request("/api/stt/transcribe", multipartTranscribe(profile.id));
    expect(res.status).toBe(200);
  });

  test("emotion toggle: forced OFF for pure-ASR backends, kept for gemini; annotation stays off the dictation wire", async () => {
    const { app } = await makeApp();

    // Pure-ASR backend with a rogue true → forced false.
    const compatRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Compat",
        backend: "openai-compat",
        config: OPENAI_COMPAT_CONFIG,
        emotionAnnotation: true,
      }),
    });
    const compat = (await compatRes.json()) as { emotionAnnotation: boolean };
    expect(compat.emotionAnnotation).toBe(false);

    // Gemini keeps the flag…
    const geminiRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Gemini",
        backend: "gemini",
        config: { model: "gemini-test" },
        apiKey: "g-key",
        emotionAnnotation: true,
      }),
    });
    const gemini = (await geminiRes.json()) as { id: string; emotionAnnotation: boolean };
    expect(gemini.emotionAnnotation).toBe(true);

    // …and a backend flip on update re-forces it off.
    const flipped = await app.request(`/api/stt/profiles/${gemini.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "openai-compat", config: OPENAI_COMPAT_CONFIG }),
    });
    const flippedBody = (await flipped.json()) as { emotionAnnotation: boolean };
    expect(flippedBody.emotionAnnotation).toBe(false);

    // Dictation wire carries the transcript only — the tone annotation is a
    // voice-message concern (the chat path reads it off the ADAPTER, not the
    // route). A SEPARATE gemini profile: the one above was just flipped.
    const wireRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Gemini 2",
        backend: "gemini",
        config: { model: "gemini-test" },
        apiKey: "g-key",
        emotionAnnotation: true,
      }),
    });
    const wireProfile = (await wireRes.json()) as { id: string };
    globalThis.fetch = mock(async () =>
      interactionsJsonReply(JSON.stringify({ transcript: "words", tone: "calm" })),
    );
    const res = await app.request("/api/stt/transcribe", multipartTranscribe(wireProfile.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; annotation?: string };
    expect(body.text).toBe("words");
    expect(body.annotation).toBeUndefined();
  });

  test("adapter returns the annotation for the chat path (route-independent seam)", async () => {
    const db = await createDb(":memory:");
    const stt = new SttStore(db, { clock: fixedClock, idGenerator: makeIdGen() });
    const providers = new ProviderStore(db, { clock: fixedClock, idGenerator: makeIdGen() });
    const tts = new TtsStore(db, { clock: fixedClock, idGenerator: makeIdGen() });
    const adapter = new SttAdapter({ stt, providers, tts });
    const created = await stt.create({
      name: "Gemini",
      backend: "gemini" as never,
      config: { model: "gemini-test" },
      apiKey: "g-key",
      emotionAnnotation: true,
      isDefault: false,
    } as never);

    globalThis.fetch = mock(async () =>
      interactionsJsonReply(JSON.stringify({ transcript: "слова", tone: "дрожит" })),
    );
    const result = await adapter.transcribeSttAudio(created.id, {
      buffer: Buffer.from([1, 2, 3]),
      mimeType: "audio/webm",
      fileName: "note.webm",
    });
    expect(result).toMatchObject({ text: "слова", annotation: "дрожит" });
  });
});

describe("STT routes — draft model discovery (P8)", () => {
  test("openai-compat draft: list passthrough with enrichment; Bearer + modality filter URL", async () => {
    const { app } = await makeApp();

    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock(async (input: FetchArgs[0], init?: FetchArgs[1]) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          data: [
            { id: "whisper-1", name: "Whisper" },
            { id: "or-free", description: "free tier", pricing: { prompt: "0", completion: "0" } },
          ],
        }),
        { status: 200 },
      );
    });

    const res = await app.request("/api/stt/draft/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: "openai-compat",
        config: { endpoint: "http://localhost:8000/v1", apiKey: "sk-own" },
      }),
    });
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string; isFree?: boolean }>;
    expect(list.length).toBe(2);
    expect(list[0]).toEqual({ id: "whisper-1", label: "Whisper" });
    expect(list[1].isFree).toBe(true);

    // The STT twin of the TTS modality discovery URL.
    expect(capturedUrl).toBe("http://localhost:8000/v1/models?output_modalities=transcription");
    const auth = (capturedInit?.headers as Record<string, string> | undefined)?.["Authorization"];
    expect(auth).toBe("Bearer sk-own");
  });

  test("whisper-browser → 400 model listing not supported (fixed local roster)", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/stt/draft/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "whisper-browser", config: { model: "onnx-community/whisper-base" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("model listing not supported");
  });

  test("profileId resolves the stored key (endpoint-guarded); gemini vendor filter", async () => {
    const { app } = await makeApp();

    const profileRes = await app.request("/api/stt/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Cloud",
        backend: "openai-compat",
        config: OPENAI_COMPAT_CONFIG,
        apiKey: "sk-stored",
      }),
    });
    const profile = (await profileRes.json()) as { id: string };

    let auth: string | undefined;
    globalThis.fetch = mock(async (_input: FetchArgs[0], init?: FetchArgs[1]) => {
      auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      return new Response(JSON.stringify({ data: [{ id: "whisper-1" }] }), { status: 200 });
    });

    // Draft config carries NO key; profileId + matching endpoint reuses the
    // stored one (the TTS draft-endpoint semantics).
    const res = await app.request("/api/stt/draft/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: "openai-compat",
        config: { endpoint: OPENAI_COMPAT_CONFIG.endpoint },
        profileId: profile.id,
      }),
    });
    expect(res.status).toBe(200);
    expect(auth).toBe("Bearer sk-stored");

    // Gemini: catalogue fetch filtered to chat/audio families, key in the
    // x-goog-api-key header (the STT picker rides the SAME catalogue).
    let geminiKey: string | undefined;
    globalThis.fetch = mock(async (input: FetchArgs[0], init?: FetchArgs[1]) => {
      geminiKey = (init?.headers as Record<string, string> | undefined)?.["x-goog-api-key"];
      expect(String(input)).toContain("generativelanguage.googleapis.com");
      return new Response(
        JSON.stringify({
          models: [
            { name: "models/gemini-3.8-flash" },
            { name: "models/gemini-2.5-flash-preview-tts" },
            { name: "models/veo-3.0" },
          ],
        }),
        { status: 200 },
      );
    });
    const geminiRes = await app.request("/api/stt/draft/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: "gemini",
        config: { apiKey: "g-key" },
      }),
    });
    expect(geminiRes.status).toBe(200);
    const geminiList = (await geminiRes.json()) as Array<{ id: string }>;
    expect(geminiList).toEqual([{ id: "gemini-3.8-flash", label: "gemini-3.8-flash" }]);
    expect(geminiKey).toBe("g-key");
  });

  test("upstream HTTP failure maps to 502 (4xx upstream → 400)", async () => {
    const { app } = await makeApp();
    globalThis.fetch = mock(async () => new Response("boom", { status: 503 }));
    const res = await app.request("/api/stt/draft/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "openai-compat", config: { endpoint: "http://localhost:8000/v1", apiKey: "k" } }),
    });
    expect(res.status).toBe(502);
  });
});
