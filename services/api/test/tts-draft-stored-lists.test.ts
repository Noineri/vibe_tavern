/**
 * TTS stored lists (IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 11b; the TTS
 * fork of the image-gen step-11 block in imagegen-routes.test.ts). Owner
 * 2026-10-15: pick the model once, never re-request the list just to open the
 * profile — the LLM provider picker pattern.
 *
 * Real in-memory database + real adapter + real route; only the upstream fetch
 * is faked, with a transport that counts its calls. Surfaces under test:
 *  - POST /api/tts/draft/models  (stored `models` list)
 *  - POST /api/tts/draft/voices  (stored `{ voices, capabilities }` envelope,
 *    one per model id)
 * `source: "stored"` is the open path; no `source` is the refresh path.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { TTS_BACKEND } from "@vibe-tavern/domain";
import {
  createDb,
  ProviderStore,
  TtsListingSnapshotStore,
  TtsStore,
  ttsListingSnapshots as ttsListingSnapshotRows,
} from "@vibe-tavern/db";

import { TtsAdapter } from "../src/api/adapters/tts-adapter.js";
import { createTtsRoutes } from "../src/api/routes/tts.js";
import { openAiCompatTtsFactory } from "../src/domain/tts/backends/openai-tts.js";
import type { TtsBackend } from "../src/domain/tts/tts-backend.js";
import {
  __restoreTtsRegistryForTests,
  __snapshotTtsRegistryForTests,
  registerTtsBackend,
} from "../src/domain/tts/tts-registry.js";

const fixedClock = { now: () => "2026-10-16T00:00:00.000Z" };

function makeIdGen() {
  let counter = 0;
  return { next: (prefix: string) => `${prefix}_test_${++counter}` };
}

type FetchArgs = Parameters<typeof fetch>;
const originalFetch = globalThis.fetch;

// Shared-process rule: this file registers real/stub factories; the snapshot
// restore in afterAll leaves the registry as later files expect to find it.
const registrySnapshot = __snapshotTtsRegistryForTests();

beforeEach(() => {
  globalThis.fetch = originalFetch;
  registerTtsBackend(TTS_BACKEND.OpenAiCompatible, openAiCompatTtsFactory);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  __restoreTtsRegistryForTests(registrySnapshot);
});

/** Installs a fetch fake that counts every upstream call and answers via `handler`. */
function installCountingTransport(handler: (url: URL) => Response) {
  const counter = { calls: 0, urls: [] as string[] };
  globalThis.fetch = mock(async (input: FetchArgs[0]) => {
    counter.calls += 1;
    counter.urls.push(String(input));
    return handler(new URL(String(input)));
  });
  return counter;
}

const ENDPOINT = "http://localhost:8880/v1";
const OTHER_ENDPOINT = "http://localhost:9000/v1";

async function makeApp() {
  const db = await createDb(":memory:");
  const tts = new TtsStore(db, { clock: fixedClock, idGenerator: makeIdGen() });
  const providers = new ProviderStore(db, { clock: fixedClock, idGenerator: makeIdGen() });
  const ttsListingSnapshots = new TtsListingSnapshotStore(db, { clock: fixedClock });
  const app = createTtsRoutes(new TtsAdapter({ tts, providers, ttsListingSnapshots }));
  return { app, tts, providers, ttsListingSnapshots, db };
}

type App = Awaited<ReturnType<typeof makeApp>>["app"];

async function seedProfile(
  app: App,
  overrides: { backend?: string; config?: Record<string, unknown>; apiKey?: string; providerRef?: string } = {},
): Promise<string> {
  const res = await app.request("/api/tts/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Local",
      backend: overrides.backend ?? "openai-compatible",
      config: overrides.config ?? { endpoint: ENDPOINT, model: "tts-1" },
      voiceId: "alloy",
      ...(overrides.apiKey !== undefined ? { apiKey: overrides.apiKey } : {}),
      ...(overrides.providerRef !== undefined ? { providerRef: overrides.providerRef } : {}),
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

function post(app: App, path: string, body: Record<string, unknown>) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(app: App, id: string, body: Record<string, unknown>) {
  return app.request(`/api/tts/profiles/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** An OpenAI-compatible `/models` answer for the plain catalog. */
function modelsAnswer(ids: string[]): Response {
  return Response.json({ data: ids.map((id) => ({ id })) });
}

describe("TTS draft models — stored-first open path", () => {
  const modelsBody = (profileId: string | undefined, extra: Record<string, unknown> = {}) => ({
    backend: "openai-compatible",
    config: { endpoint: ENDPOINT, model: "tts-1" },
    ...(profileId !== undefined ? { profileId } : {}),
    ...extra,
  });

  test("a stored list answers with zero upstream calls", async () => {
    const counter = installCountingTransport(() => modelsAnswer(["tts-1", "tts-hd"]));
    const { app } = await makeApp();
    const id = await seedProfile(app);
    const live = await post(app, "/api/tts/draft/models", modelsBody(id));
    expect(live.status).toBe(200);
    const liveBody = await live.json();
    const callsAfterLive = counter.calls;
    expect(callsAfterLive).toBeGreaterThan(0);

    const stored = await post(app, "/api/tts/draft/models", modelsBody(id, { source: "stored" }));
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual(liveBody);
    expect(counter.calls).toBe(callsAfterLive);
  });

  test("nothing stored -> one live listing, recorded for the next open", async () => {
    const counter = installCountingTransport(() => modelsAnswer(["tts-1"]));
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app);
    expect(await ttsListingSnapshots.get(id, "models")).toBeNull();

    const first = await post(app, "/api/tts/draft/models", modelsBody(id, { source: "stored" }));
    expect(first.status).toBe(200);
    expect(counter.calls).toBe(1);
    expect(await ttsListingSnapshots.get(id, "models")).not.toBeNull();

    const second = await post(app, "/api/tts/draft/models", modelsBody(id, { source: "stored" }));
    expect(await second.json()).toEqual(await first.json());
    expect(counter.calls).toBe(1);
  });

  test("refresh (no source) lists live and overwrites; the next stored read shows the new roster", async () => {
    let roster = ["old-model"];
    const counter = installCountingTransport(() => modelsAnswer(roster));
    const { app } = await makeApp();
    const id = await seedProfile(app);
    await post(app, "/api/tts/draft/models", modelsBody(id));

    roster = ["new-model"];
    const callsBefore = counter.calls;
    const refreshed = (await (await post(app, "/api/tts/draft/models", modelsBody(id))).json()) as Array<{ id: string }>;
    expect(counter.calls).toBeGreaterThan(callsBefore);
    expect(refreshed.map((m) => m.id)).toEqual(["new-model"]);

    const callsAfterRefresh = counter.calls;
    const reopened = (await (await post(app, "/api/tts/draft/models", modelsBody(id, { source: "stored" }))).json()) as Array<{ id: string }>;
    expect(reopened.map((m) => m.id)).toEqual(["new-model"]);
    expect(counter.calls).toBe(callsAfterRefresh);
  });

  test("a config pointing at another endpoint is never read from or written under the profile", async () => {
    let roster = ["original"];
    const counter = installCountingTransport(() => modelsAnswer(roster));
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app);
    await post(app, "/api/tts/draft/models", modelsBody(id));
    const stored = await ttsListingSnapshots.get(id, "models");

    // An unsaved edit that points elsewhere (the Test-connection button, the
    // local-server status chip): the stored list is not served for it...
    roster = ["from-elsewhere"];
    const callsBefore = counter.calls;
    const elsewhere = await post(app, "/api/tts/draft/models", {
      backend: "openai-compatible",
      config: { endpoint: OTHER_ENDPOINT, model: "tts-1" },
      profileId: id,
      source: "stored",
    });
    expect(elsewhere.status).toBe(200);
    expect(((await elsewhere.json()) as Array<{ id: string }>).map((m) => m.id)).toEqual(["from-elsewhere"]);
    expect(counter.calls).toBeGreaterThan(callsBefore);
    expect(counter.urls[counter.urls.length - 1]).toContain(OTHER_ENDPOINT);

    // ...and its answer is not written under the profile.
    expect(await ttsListingSnapshots.get(id, "models")).toEqual(stored);
  });

  test("a different backend with the profile's id is never written under the profile", async () => {
    const stubGemini: TtsBackend = {
      generate: async () => ({ audio: Buffer.from([1]), mime: "audio/wav" }),
      listVoices: async () => [],
      listModels: async () => [{ id: "gemini-tts", label: "gemini-tts" }],
      probe: async () => ({ ok: true }),
      dispose: async () => {},
      capabilities: () => ({ supportsCloning: false }),
    };
    registerTtsBackend(TTS_BACKEND.Gemini, () => stubGemini);
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app);

    const res = await post(app, "/api/tts/draft/models", {
      backend: "gemini",
      config: { apiKey: "k" },
      profileId: id,
    });
    expect(res.status).toBe(200);
    expect(await ttsListingSnapshots.get(id, "models")).toBeNull();
  });

  test("an unknown profile id and a brand-new profile (no id) list live and store nothing", async () => {
    const counter = installCountingTransport(() => modelsAnswer(["tts-1"]));
    const { app, db } = await makeApp();

    const brandNew = await post(app, "/api/tts/draft/models", modelsBody(undefined, { source: "stored" }));
    expect(brandNew.status).toBe(200);
    const unknown = await post(app, "/api/tts/draft/models", modelsBody("tts_profile_missing", { source: "stored" }));
    expect(unknown.status).toBe(200);

    expect(counter.calls).toBe(2);
    expect(await db.select().from(ttsListingSnapshotRows)).toHaveLength(0);
  });

  test("renaming keeps the stored list; a changed endpoint drops it and the next open lists the new server live", async () => {
    const counter = installCountingTransport(() => modelsAnswer(["tts-1"]));
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app);
    await post(app, "/api/tts/draft/models", modelsBody(id));

    const renamed = await patch(app, id, { name: "Renamed" });
    expect(renamed.status).toBe(200);
    expect(await ttsListingSnapshots.get(id, "models")).not.toBeNull();

    const moved = await patch(app, id, { config: { endpoint: OTHER_ENDPOINT, model: "tts-1" } });
    expect(moved.status).toBe(200);
    expect(await ttsListingSnapshots.get(id, "models")).toBeNull();

    const callsBefore = counter.calls;
    const reopened = await post(app, "/api/tts/draft/models", {
      backend: "openai-compatible",
      config: { endpoint: OTHER_ENDPOINT, model: "tts-1" },
      profileId: id,
      source: "stored",
    });
    expect(reopened.status).toBe(200);
    expect(counter.calls).toBeGreaterThan(callsBefore);
  });

  test("a changed backend drops every stored list of the profile", async () => {
    installCountingTransport(() => modelsAnswer(["tts-1"]));
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app);
    await post(app, "/api/tts/draft/models", modelsBody(id));
    await ttsListingSnapshots.put(id, "voices:tts-1", { voices: null, capabilities: { supportsCloning: false } });

    const switched = await patch(app, id, { backend: "gemini", config: { model: "gemini-tts" } });
    expect(switched.status).toBe(200);

    expect(await ttsListingSnapshots.get(id, "models")).toBeNull();
    expect(await ttsListingSnapshots.get(id, "voices:tts-1")).toBeNull();
  });

  test("an unreadable stored payload counts as nothing stored (live path, then rewritten)", async () => {
    const counter = installCountingTransport(() => modelsAnswer(["tts-1"]));
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app);
    await ttsListingSnapshots.put(id, "models", { not: "a model list" });

    const res = await post(app, "/api/tts/draft/models", modelsBody(id, { source: "stored" }));
    expect(res.status).toBe(200);
    expect(counter.calls).toBe(1);
    expect(((await res.json()) as Array<{ id: string }>).map((m) => m.id)).toEqual(["tts-1"]);
    expect((await ttsListingSnapshots.get(id, "models"))!.payload).toEqual([{ id: "tts-1", label: "tts-1" }]);
  });

  test("a failed live listing surfaces as before and leaves the stored list untouched (no failure fallback)", async () => {
    let up = true;
    installCountingTransport(() => (up ? modelsAnswer(["tts-1"]) : new Response("boom", { status: 503 })));
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app);
    await post(app, "/api/tts/draft/models", modelsBody(id));
    const stored = await ttsListingSnapshots.get(id, "models");

    up = false;
    const refresh = await post(app, "/api/tts/draft/models", modelsBody(id));
    expect(refresh.status).toBe(500);
    expect(await ttsListingSnapshots.get(id, "models")).toEqual(stored);

    // The open path still answers from storage while the server is down.
    const open = await post(app, "/api/tts/draft/models", modelsBody(id, { source: "stored" }));
    expect(open.status).toBe(200);
  });

  test("a backend without a model list answers 400 as before and stores nothing", async () => {
    const noList: TtsBackend = {
      generate: async () => ({ audio: Buffer.from([1]), mime: "audio/wav" }),
      listVoices: async () => [],
      probe: async () => ({ ok: true }),
      dispose: async () => {},
      capabilities: () => ({ supportsCloning: false }),
    };
    registerTtsBackend(TTS_BACKEND.Gemini, () => noList);
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app, { backend: "gemini", config: { model: "gemini-tts" }, apiKey: "k" });

    const res = await post(app, "/api/tts/draft/models", {
      backend: "gemini",
      config: { model: "gemini-tts" },
      profileId: id,
      source: "stored",
    });
    expect(res.status).toBe(400);
    expect(await ttsListingSnapshots.get(id, "models")).toBeNull();
  });

  test("an unknown source value is a 400", async () => {
    installCountingTransport(() => modelsAnswer(["tts-1"]));
    const { app } = await makeApp();
    const id = await seedProfile(app);
    expect((await post(app, "/api/tts/draft/models", modelsBody(id, { source: "cache" }))).status).toBe(400);
  });

  test("a providerRef profile is matched through its effective (provider) endpoint", async () => {
    const counter = installCountingTransport(() => modelsAnswer(["tts-1"]));
    const { app, providers, ttsListingSnapshots } = await makeApp();
    const provider = await providers.create({
      name: "Aggregator",
      providerPreset: "openrouter",
      endpoint: "https://aggregator.example/api/v1",
      apiKey: "prov-key",
    });
    const id = await seedProfile(app, { config: { model: "tts-1" }, providerRef: provider.id });
    const body = { backend: "openai-compatible", config: { endpoint: "https://aggregator.example/api/v1" }, profileId: id };

    expect((await post(app, "/api/tts/draft/models", body)).status).toBe(200);
    expect(await ttsListingSnapshots.get(id, "models")).not.toBeNull();
    const callsAfterLive = counter.calls;

    expect((await post(app, "/api/tts/draft/models", { ...body, source: "stored" })).status).toBe(200);
    expect(counter.calls).toBe(callsAfterLive);
  });
});

describe("TTS draft voices — stored per model, with capabilities", () => {
  /** An OpenRouter-style catalog (`modelFilter: "modality"`): the voice roster
   *  is per-model data riding the /models entry of the config's model. */
  const catalogHandler = (rosters: Record<string, string[]>) => (url: URL) => {
    if (url.pathname.endsWith("/models")) {
      return Response.json({
        data: Object.entries(rosters).map(([id, voices]) => ({ id, supported_voices: voices })),
      });
    }
    return new Response("not found", { status: 404 });
  };

  const voicesBody = (profileId: string | undefined, model: string, extra: Record<string, unknown> = {}) => ({
    backend: "openai-compatible",
    config: { endpoint: ENDPOINT, model, modelFilter: "modality" },
    ...(profileId !== undefined ? { profileId } : {}),
    ...extra,
  });

  const voiceIds = async (res: Response) =>
    ((await res.json()) as { voices: Array<{ id: string }> | null }).voices?.map((v) => v.id);

  test("voices stored for model A are not served for model B; each model keeps its own row", async () => {
    const counter = installCountingTransport(catalogHandler({ "model-a": ["alice"], "model-b": ["bob"] }));
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app, { config: { endpoint: ENDPOINT, model: "model-a", modelFilter: "modality" } });

    expect(await voiceIds(await post(app, "/api/tts/draft/voices", voicesBody(id, "model-a", { source: "stored" })))).toEqual(["alice"]);
    expect(counter.calls).toBe(1);
    expect(await ttsListingSnapshots.get(id, "voices:model-a")).not.toBeNull();
    expect(await ttsListingSnapshots.get(id, "voices:model-b")).toBeNull();

    // Model B has nothing stored: its first open lists live, never A's roster.
    expect(await voiceIds(await post(app, "/api/tts/draft/voices", voicesBody(id, "model-b", { source: "stored" })))).toEqual(["bob"]);
    expect(counter.calls).toBe(2);

    // Both rosters now answer from storage.
    expect(await voiceIds(await post(app, "/api/tts/draft/voices", voicesBody(id, "model-a", { source: "stored" })))).toEqual(["alice"]);
    expect(await voiceIds(await post(app, "/api/tts/draft/voices", voicesBody(id, "model-b", { source: "stored" })))).toEqual(["bob"]);
    expect(counter.calls).toBe(2);
  });

  test("the stored envelope carries the capabilities the live listing saw", async () => {
    // A chatterbox-style server: /audio/voices is absent, /voices answers —
    // the backend learns clone support from that route, during listVoices.
    const counter = installCountingTransport((url) => {
      if (url.pathname.endsWith("/audio/voices")) return new Response("not found", { status: 404 });
      if (url.pathname.endsWith("/voices")) return Response.json({ voices: [{ name: "Ada", language: "en" }] });
      return new Response("not found", { status: 404 });
    });
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app);
    const body = { backend: "openai-compatible", config: { endpoint: ENDPOINT, model: "tts-1" }, profileId: id };

    const live = (await (await post(app, "/api/tts/draft/voices", body)).json()) as {
      voices: Array<{ id: string }>;
      capabilities: { supportsCloning: boolean };
    };
    expect(live.capabilities.supportsCloning).toBe(true);
    const callsAfterLive = counter.calls;

    // A stored read builds no backend instance, yet still reports cloning.
    const stored = await post(app, "/api/tts/draft/voices", { ...body, source: "stored" });
    expect(await stored.json()).toEqual(live);
    expect(counter.calls).toBe(callsAfterLive);
    expect((await ttsListingSnapshots.get(id, "voices:tts-1"))!.payload).toEqual(live);
  });

  // Behavior fix (step 11b): a profile with a stored key used to list with
  // the SAVED config wholesale when the form sent no key — picking model B in
  // the form still listed model A's roster (and would have stored it as B's).
  test("a keyed profile lists the voices of the form's model, and stores them under that model", async () => {
    const counter = installCountingTransport(catalogHandler({ "model-a": ["alice"], "model-b": ["bob"] }));
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app, {
      config: { endpoint: ENDPOINT, model: "model-a", modelFilter: "modality" },
      apiKey: "sk-stored",
    });

    const res = await post(app, "/api/tts/draft/voices", voicesBody(id, "model-b"));
    expect(await voiceIds(res)).toEqual(["bob"]);
    expect(counter.calls).toBe(1);
    expect(((await ttsListingSnapshots.get(id, "voices:model-b"))!.payload as { voices: Array<{ id: string }> }).voices.map((v) => v.id)).toEqual(["bob"]);
    expect(await ttsListingSnapshots.get(id, "voices:model-a")).toBeNull();
  });

  test("refresh lists live and overwrites; the next stored read shows the new roster", async () => {
    let rosters = { "model-a": ["old-voice"] };
    const counter = installCountingTransport((url) => catalogHandler(rosters)(url));
    const { app } = await makeApp();
    const id = await seedProfile(app, { config: { endpoint: ENDPOINT, model: "model-a", modelFilter: "modality" } });
    await post(app, "/api/tts/draft/voices", voicesBody(id, "model-a"));

    rosters = { "model-a": ["new-voice"] };
    const callsBefore = counter.calls;
    expect(await voiceIds(await post(app, "/api/tts/draft/voices", voicesBody(id, "model-a")))).toEqual(["new-voice"]);
    expect(counter.calls).toBeGreaterThan(callsBefore);

    const callsAfterRefresh = counter.calls;
    expect(await voiceIds(await post(app, "/api/tts/draft/voices", voicesBody(id, "model-a", { source: "stored" })))).toEqual(["new-voice"]);
    expect(counter.calls).toBe(callsAfterRefresh);
  });

  test("a config pointing at another endpoint is never read from or written under the profile", async () => {
    let rosters: Record<string, string[]> = { "model-a": ["original"] };
    const counter = installCountingTransport((url) => catalogHandler(rosters)(url));
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app, { config: { endpoint: ENDPOINT, model: "model-a", modelFilter: "modality" } });
    await post(app, "/api/tts/draft/voices", voicesBody(id, "model-a"));
    const stored = await ttsListingSnapshots.get(id, "voices:model-a");

    rosters = { "model-a": ["from-elsewhere"] };
    const callsBefore = counter.calls;
    const elsewhere = await post(app, "/api/tts/draft/voices", {
      backend: "openai-compatible",
      config: { endpoint: OTHER_ENDPOINT, model: "model-a", modelFilter: "modality" },
      profileId: id,
      source: "stored",
    });
    expect(await voiceIds(elsewhere)).toEqual(["from-elsewhere"]);
    expect(counter.calls).toBeGreaterThan(callsBefore);

    expect(await ttsListingSnapshots.get(id, "voices:model-a")).toEqual(stored);
  });

  test("a changed endpoint drops the stored voices — the next open lists the new server live", async () => {
    const counter = installCountingTransport(catalogHandler({ "model-a": ["alice"] }));
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app, { config: { endpoint: ENDPOINT, model: "model-a", modelFilter: "modality" } });
    await post(app, "/api/tts/draft/voices", voicesBody(id, "model-a"));
    expect(await ttsListingSnapshots.get(id, "voices:model-a")).not.toBeNull();

    const moved = await patch(app, id, { config: { endpoint: OTHER_ENDPOINT, model: "model-a", modelFilter: "modality" } });
    expect(moved.status).toBe(200);
    expect(await ttsListingSnapshots.get(id, "voices:model-a")).toBeNull();

    const callsBefore = counter.calls;
    await post(app, "/api/tts/draft/voices", {
      backend: "openai-compatible",
      config: { endpoint: OTHER_ENDPOINT, model: "model-a", modelFilter: "modality" },
      profileId: id,
      source: "stored",
    });
    expect(counter.calls).toBeGreaterThan(callsBefore);
  });

  test("an unreadable stored envelope counts as nothing stored (live path)", async () => {
    const counter = installCountingTransport(catalogHandler({ "model-a": ["alice"] }));
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app, { config: { endpoint: ENDPOINT, model: "model-a", modelFilter: "modality" } });
    // A bare voice array (no envelope) is not a stored answer.
    await ttsListingSnapshots.put(id, "voices:model-a", [{ id: "x", label: "x", lang: "en" }]);

    const res = await post(app, "/api/tts/draft/voices", voicesBody(id, "model-a", { source: "stored" }));
    expect(await voiceIds(res)).toEqual(["alice"]);
    expect(counter.calls).toBe(1);
  });

  // `voices: null` is both the manual-input floor and what the
  // OpenAI-compatible backend answers when its voice listing fails upstream —
  // serving it from storage would pin a transient failure. A stored envelope
  // without voices counts as nothing stored (the empty rule), so the open
  // path lists live.
  test("a null-voices answer is recorded but counts as nothing stored — the open path lists live", async () => {
    const counter = installCountingTransport(() => new Response("not found", { status: 404 }));
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app);
    const body = { backend: "openai-compatible", config: { endpoint: ENDPOINT, model: "tts-1" }, profileId: id };

    const live = await (await post(app, "/api/tts/draft/voices", body)).json();
    expect((live as { voices: unknown }).voices).toBeNull();
    expect((await ttsListingSnapshots.get(id, "voices:tts-1"))!.payload).toEqual(live);
    const callsAfterLive = counter.calls;

    const reopened = await post(app, "/api/tts/draft/voices", { ...body, source: "stored" });
    expect(await reopened.json()).toEqual(live);
    expect(counter.calls).toBeGreaterThan(callsAfterLive);
  });

  test("an empty stored voice list counts as nothing stored", async () => {
    const counter = installCountingTransport(catalogHandler({ "model-a": ["alice"] }));
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app, { config: { endpoint: ENDPOINT, model: "model-a", modelFilter: "modality" } });
    await ttsListingSnapshots.put(id, "voices:model-a", { voices: [], capabilities: { supportsCloning: false } });

    const res = await post(app, "/api/tts/draft/voices", voicesBody(id, "model-a", { source: "stored" }));
    expect(await voiceIds(res)).toEqual(["alice"]);
    expect(counter.calls).toBe(1);
  });

  test("region-scoped rosters (Azure / Polly): another region is never read from or written under the profile; a region change drops the lists", async () => {
    const rosterFor = (region: unknown) => [{ id: `voice-${String(region)}`, label: "V", lang: "en-US" }];
    const stubAzure = (config: Record<string, unknown>): TtsBackend => ({
      generate: async () => ({ audio: Buffer.from([1]), mime: "audio/mpeg" }),
      listVoices: async () => rosterFor(config.region),
      probe: async () => ({ ok: true }),
      dispose: async () => {},
      capabilities: () => ({ supportsCloning: false }),
    });
    registerTtsBackend(TTS_BACKEND.Azure, (config) => stubAzure(config as Record<string, unknown>));
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app, { backend: "azure", config: { region: "westus" }, apiKey: "az-key" });
    const westBody = { backend: "azure", config: { region: "westus" }, profileId: id };

    await post(app, "/api/tts/draft/voices", westBody);
    const stored = await ttsListingSnapshots.get(id, "voices:");
    expect(stored!.payload).toEqual({ voices: rosterFor("westus"), capabilities: { supportsCloning: false } });

    // Same profile id, another region: answered live for that region, never
    // from the westus row, and the westus row stays as it was.
    const east = await post(app, "/api/tts/draft/voices", { ...westBody, config: { region: "eastus" }, source: "stored" });
    expect(await voiceIds(east)).toEqual(["voice-eastus"]);
    expect(await ttsListingSnapshots.get(id, "voices:")).toEqual(stored);

    // A saved region change is a different roster: the stored lists go.
    expect((await patch(app, id, { config: { region: "eastus" } })).status).toBe(200);
    expect(await ttsListingSnapshots.get(id, "voices:")).toBeNull();
  });

  test("kokoro keeps its 400 (browser-only) on the open path and stores nothing", async () => {
    const { app, db } = await makeApp();
    const res = await post(app, "/api/tts/draft/voices", {
      backend: "kokoro",
      config: {},
      profileId: "tts_profile_any",
      source: "stored",
    });
    expect(res.status).toBe(400);
    expect(await db.select().from(ttsListingSnapshotRows)).toHaveLength(0);
  });

  test("a native vendor keys its voices by the model field that backend reads (modelId)", async () => {
    const roster = [{ id: "v1", label: "V1", lang: "en" }];
    const stubCartesia: TtsBackend = {
      generate: async () => ({ audio: Buffer.from([1]), mime: "audio/wav" }),
      listVoices: async () => roster,
      probe: async () => ({ ok: true }),
      dispose: async () => {},
      capabilities: () => ({ supportsCloning: true }),
    };
    registerTtsBackend(TTS_BACKEND.Cartesia, () => stubCartesia);
    const { app, ttsListingSnapshots } = await makeApp();
    const id = await seedProfile(app, { backend: "cartesia", config: { modelId: "sonic-3" }, apiKey: "k" });

    const res = await post(app, "/api/tts/draft/voices", {
      // `model` is not a field this backend reads — it must not name the row.
      backend: "cartesia",
      config: { modelId: "sonic-3", model: "stale-openai-field" },
      profileId: id,
    });
    expect(res.status).toBe(200);
    expect((await ttsListingSnapshots.get(id, "voices:sonic-3"))!.payload).toEqual({
      voices: roster,
      capabilities: { supportsCloning: true },
    });
    expect(await ttsListingSnapshots.get(id, "voices:stale-openai-field")).toBeNull();
  });
});
