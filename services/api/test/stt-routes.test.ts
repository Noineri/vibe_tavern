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
import { SttAdapter } from "../src/api/adapters/stt-adapter.js";

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
import {
  __resetSttRegistryForTests,
  registerSttBackend,
} from "../src/domain/stt/stt-registry.js";
import { STT_BACKENDS } from "@vibe-tavern/domain";

beforeEach(() => {
  __resetSttRegistryForTests();
  registerSttBackend(STT_BACKENDS.OpenAiCompat, openAiCompatSttFactory);
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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