import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";
import { createDb } from "@vibe-tavern/db";
import { TtsStore } from "@vibe-tavern/db";

import { createTtsRoutes } from "../src/api/routes/tts.js";
import { TtsAdapter } from "../src/api/adapters/tts-adapter.js";
import {
  __resetTtsRegistryForTests,
  registerTtsBackend,
} from "../src/domain/tts/tts-registry.js";
import type { TtsBackend } from "../src/domain/tts/tts-backend.js";

const fixedClock = { now: () => "2026-08-27T00:00:00.000Z" };

function makeIdGen() {
  let counter = 0;
  return { next: (prefix: string) => `${prefix}_test_${++counter}` };
}

async function makeApp() {
  const db = await createDb(":memory:");
  const store = new TtsStore(db, { clock: fixedClock, idGenerator: makeIdGen() });
  const adapter = new TtsAdapter({ tts: store } as never);
  const app = createTtsRoutes(adapter);
  return { app, store, db };
}

beforeEach(() => {
  __resetTtsRegistryForTests();
});

afterEach(() => {
  __resetTtsRegistryForTests();
});

function stubBackend(overrides: Partial<TtsBackend> = {}): TtsBackend {
  return {
    generate: async () => ({ audio: Buffer.from([1, 2, 3, 4]), mime: "audio/wav" }),
    listVoices: async () => [{ id: "v1", label: "V1", lang: "en" }],
    probe: async () => ({ ok: true }),
    dispose: async () => {},
    ...overrides,
  };
}

describe("TTS routes — CRUD", () => {
  test("POST /api/tts/profiles → 201, GET :id round-trip, GET all", async () => {
    const { app } = await makeApp();

    const createdRes = await app.request("/api/tts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Kokoro — Heart", backend: "kokoro", voiceId: "af_heart" }),
    });
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as { id: string; name: string };
    expect(created.name).toBe("Kokoro — Heart");

    const getRes = await app.request(`/api/tts/profiles/${created.id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { id: string };
    expect(fetched.id).toBe(created.id);

    const allRes = await app.request("/api/tts/profiles/all");
    expect(allRes.status).toBe(200);
    const all = (await allRes.json()) as unknown[];
    expect(all.length).toBe(1);
  });

  test("PATCH unknown id → 404; DELETE → ok:true", async () => {
    const { app } = await makeApp();

    const patchRes = await app.request("/api/tts/profiles/missing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(patchRes.status).toBe(404);

    const delRes = await app.request("/api/tts/profiles/missing", { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { ok: boolean };
    expect(delBody.ok).toBe(true);
  });

  test("PUT default → pointer moves", async () => {
    const { app } = await makeApp();

    const aRes = await app.request("/api/tts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "A", backend: "kokoro", isDefault: true }),
    });
    const a = (await aRes.json()) as { id: string };
    const bRes = await app.request("/api/tts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "B", backend: "kokoro" }),
    });
    const b = (await bRes.json()) as { id: string };

    const putRes = await app.request(`/api/tts/profiles/${b.id}/default`, { method: "PUT" });
    expect(putRes.status).toBe(200);

    const getA = (await (await app.request(`/api/tts/profiles/${a.id}`)).json()) as { isDefault: boolean };
    const getB = (await (await app.request(`/api/tts/profiles/${b.id}`)).json()) as { isDefault: boolean };
    expect(getA.isDefault).toBe(false);
    expect(getB.isDefault).toBe(true);
  });

  test("PUT links → round-trip link list", async () => {
    const { app } = await makeApp();

    const createdRes = await app.request("/api/tts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "P", backend: "kokoro" }),
    });
    const profile = (await createdRes.json()) as { id: string };

    const putRes = await app.request(`/api/tts/profiles/${profile.id}/links`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ links: [{ targetType: "character", targetId: "char_1" }] }),
    });
    expect(putRes.status).toBe(200);
    const links = (await putRes.json()) as unknown[];
    expect(links.length).toBe(1);

    const getRes = await app.request(`/api/tts/profiles/${profile.id}/links`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as unknown[];
    expect(fetched.length).toBe(1);
  });

  test("GET /api/tts/links returns all links across profiles", async () => {
    const { app, store } = await makeApp();

    const aRes = await app.request("/api/tts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "A", backend: "kokoro" }),
    });
    const a = (await aRes.json()) as { id: string };
    const bRes = await app.request("/api/tts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "B", backend: "kokoro" }),
    });
    const b = (await bRes.json()) as { id: string };

    await store.addLink(a.id, "character" as never, "char_1");
    await store.addLink(b.id, "persona" as never, "persona_1");

    const res = await app.request("/api/tts/links");
    expect(res.status).toBe(200);
    const all = (await res.json()) as unknown[];
    expect(all.length).toBe(2);
  });
});

describe("TTS routes — generate + voices", () => {
  test("POST /api/tts/generate happy path → 200 binary audio", async () => {
    registerTtsBackend(TTS_BACKEND.OpenAiCompatible, () => stubBackend());
    const { app } = await makeApp();

    const createdRes = await app.request("/api/tts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "OpenAI Compat",
        backend: "openai-compatible",
        voiceId: "af_bella",
        config: { endpoint: "http://localhost:8880/v1" },
      }),
    });
    const profile = (await createdRes.json()) as { id: string };

    const genRes = await app.request("/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: profile.id, text: "Hello world" }),
    });
    expect(genRes.status).toBe(200);
    expect(genRes.headers.get("content-type")).toBe("audio/wav");
    const buf = new Uint8Array(await genRes.arrayBuffer());
    expect([...buf]).toEqual([1, 2, 3, 4]);
  });

  test("POST /api/tts/generate unknown profile → 404", async () => {
    registerTtsBackend(TTS_BACKEND.OpenAiCompatible, () => stubBackend());
    const { app } = await makeApp();

    const genRes = await app.request("/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "missing", text: "hi" }),
    });
    expect(genRes.status).toBe(404);
  });

  test("POST /api/tts/generate with kokoro profile → 400", async () => {
    const { app } = await makeApp();

    const createdRes = await app.request("/api/tts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Kokoro", backend: "kokoro", voiceId: "af_heart" }),
    });
    const profile = (await createdRes.json()) as { id: string };

    const genRes = await app.request("/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: profile.id, text: "hi" }),
    });
    expect(genRes.status).toBe(400);
    const body = (await genRes.json()) as { error: string };
    expect(body.error).toContain("kokoro runs client-side");
  });

  test("GET /api/tts/profiles/:id/voices passthrough; unknown → 404", async () => {
    registerTtsBackend(TTS_BACKEND.OpenAiCompatible, () =>
      stubBackend({
        listVoices: async () => [{ id: "v1", label: "V1", lang: "en" }],
      }),
    );
    const { app } = await makeApp();

    const createdRes = await app.request("/api/tts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "P",
        backend: "openai-compatible",
        config: { endpoint: "http://localhost:8880/v1" },
      }),
    });
    const profile = (await createdRes.json()) as { id: string };

    const voicesRes = await app.request(`/api/tts/profiles/${profile.id}/voices`);
    expect(voicesRes.status).toBe(200);
    const voices = (await voicesRes.json()) as unknown[];
    expect(voices.length).toBe(1);

    const missingRes = await app.request("/api/tts/profiles/missing/voices");
    expect(missingRes.status).toBe(404);
  });

  test("POST /api/tts/generate validation: empty text → 400", async () => {
    registerTtsBackend(TTS_BACKEND.OpenAiCompatible, () => stubBackend());
    const { app } = await makeApp();

    const createdRes = await app.request("/api/tts/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "P", backend: "openai-compatible" }),
    });
    const profile = (await createdRes.json()) as { id: string };

    const genRes = await app.request("/api/tts/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: profile.id, text: "" }),
    });
    expect(genRes.status).toBe(400);
  });
});

describe("TTS routes — draft (transient, unsaved form config)", () => {
  test("POST /api/tts/draft/voices → factory gets the transient config verbatim; no DB row needed", async () => {
    let seenConfig: Record<string, unknown> | null = null;
    registerTtsBackend(TTS_BACKEND.OpenAiCompatible, (config) => {
      seenConfig = { ...(config as Record<string, unknown>) };
      return stubBackend({ listVoices: async () => [{ id: "alloy", label: "Alloy", lang: "en" }] });
    });
    const { app } = await makeApp();

    const res = await app.request("/api/tts/draft/voices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: "openai-compatible",
        config: { endpoint: "http://localhost:8880/v1", apiKey: "transient-key" },
      }),
    });
    expect(res.status).toBe(200);
    const voices = (await res.json()) as Array<{ id: string }>;
    expect(voices[0].id).toBe("alloy");
    expect((seenConfig as Record<string, unknown> | null)?.endpoint).toBe("http://localhost:8880/v1");
  });

  test("POST /api/tts/draft/voices kokoro → 400 (browser-only), not a registry 500", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/tts/draft/voices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "kokoro", config: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("kokoro runs client-side");
  });

  test("POST /api/tts/draft/preview → buffered audio + mime; transient voiceId/text reach the factory", async () => {
    let seenRequest: { text: string; voiceId: string } | null = null;
    registerTtsBackend(TTS_BACKEND.ElevenLabs, () =>
      stubBackend({
        generate: async (req) => {
          seenRequest = { text: req.text, voiceId: req.voiceId };
          return { audio: Buffer.from([9, 9, 9]), mime: "audio/mpeg" };
        },
      }),
    );
    const { app } = await makeApp();

    const res = await app.request("/api/tts/draft/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: "elevenlabs",
        config: { apiKey: "transient" },
        voiceId: "Rachel",
        text: "Hello! Preview.",
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBe(3);
    expect(seenRequest?.voiceId).toBe("Rachel");
  });

  test("POST /api/tts/draft/preview kokoro → 400; empty text → 400 (zod)", async () => {
    const { app } = await makeApp();

    const kokoroRes = await app.request("/api/tts/draft/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "kokoro", config: {}, text: "hi" }),
    });
    expect(kokoroRes.status).toBe(400);

    const badTextRes = await app.request("/api/tts/draft/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "elevenlabs", config: {}, text: "" }),
    });
    expect(badTextRes.status).toBe(400);
  });

  test("POST /api/tts/draft/models → transient config, listModels passthrough", async () => {
    let seenConfig: Record<string, unknown> | null = null;
    registerTtsBackend(TTS_BACKEND.Gemini, (config) => {
      seenConfig = { ...(config as Record<string, unknown>) };
      return stubBackend({
        listModels: async () => [
          { id: "gemini-2.5-flash-preview-tts", label: "gemini-2.5-flash-preview-tts" },
          { id: "gemini-2.5-pro-preview-tts", label: "gemini-2.5-pro-preview-tts" },
        ],
      });
    });
    const { app } = await makeApp();
    const res = await app.request("/api/tts/draft/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "gemini", config: { apiKey: "transient" } }),
    });
    expect(res.status).toBe(200);
    const models = (await res.json()) as Array<{ id: string }>;
    expect(models.length).toBe(2);
    expect(models[0].id).toBe("gemini-2.5-flash-preview-tts");
    expect(seenConfig?.apiKey).toBe("transient");
  });

  test("POST /api/tts/draft/models kokoro → 400", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/tts/draft/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "kokoro", config: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("kokoro runs client-side");
  });

  test("POST /api/tts/draft/models backend without listModels → 400", async () => {
    registerTtsBackend(TTS_BACKEND.ElevenLabs, () => stubBackend());
    const { app } = await makeApp();
    const res = await app.request("/api/tts/draft/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "elevenlabs", config: { apiKey: "k" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("model listing not supported");
  });
});
