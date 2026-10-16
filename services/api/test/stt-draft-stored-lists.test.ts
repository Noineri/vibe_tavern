/**
 * STT stored model list (IMAGEGEN_CUSTOM_ENDPOINT_FILTER_REPORT step 11b; the
 * STT fork of the image-gen step-11 block in imagegen-routes.test.ts). Owner
 * 2026-10-15: pick the model once, never re-request the list just to open the
 * profile — the LLM provider picker pattern.
 *
 * Real in-memory database + real adapter + real route; only the upstream fetch
 * is faked, with a transport that counts its calls. Surface under test:
 * POST /api/stt/draft/models — `source: "stored"` is the open path, no
 * `source` is the refresh path.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { STT_BACKENDS } from "@vibe-tavern/domain";
import {
  createDb,
  ProviderStore,
  SttListingSnapshotStore,
  SttStore,
  TtsStore,
  sttListingSnapshots as sttListingSnapshotRows,
} from "@vibe-tavern/db";

import { SttAdapter } from "../src/api/adapters/stt-adapter.js";
import { createSttRoutes } from "../src/api/routes/stt.js";
import { openAiCompatSttFactory } from "../src/domain/stt/backends/openai-stt.js";
import { geminiSttFactory } from "../src/domain/stt/backends/gemini-stt.js";
import { elevenlabsSttFactory } from "../src/domain/stt/backends/elevenlabs-stt.js";
import {
  __resetSttRegistryForTests,
  __restoreSttRegistryForTests,
  __snapshotSttRegistryForTests,
  registerSttBackend,
} from "../src/domain/stt/stt-registry.js";

const fixedClock = { now: () => "2026-10-16T00:00:00.000Z" };

function makeIdGen() {
  let counter = 0;
  return { next: (prefix: string) => `${prefix}_test_${++counter}` };
}

type FetchArgs = Parameters<typeof fetch>;
const originalFetch = globalThis.fetch;

// Shared-process rule (see stt-routes.test.ts): the registry is process-global
// and other files reset it; re-register the real factories before each test
// and restore what this file found in afterAll.
const registrySnapshot = __snapshotSttRegistryForTests();

beforeEach(() => {
  globalThis.fetch = originalFetch;
  __resetSttRegistryForTests();
  registerSttBackend(STT_BACKENDS.OpenAiCompat, openAiCompatSttFactory);
  registerSttBackend(STT_BACKENDS.Gemini, geminiSttFactory);
  registerSttBackend(STT_BACKENDS.ElevenLabs, elevenlabsSttFactory);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  __restoreSttRegistryForTests(registrySnapshot);
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

const ENDPOINT = "http://localhost:8000/v1";
const OTHER_ENDPOINT = "http://localhost:9000/v1";

async function makeApp() {
  const db = await createDb(":memory:");
  const stt = new SttStore(db, { clock: fixedClock, idGenerator: makeIdGen() });
  const providers = new ProviderStore(db, { clock: fixedClock, idGenerator: makeIdGen() });
  const tts = new TtsStore(db, { clock: fixedClock, idGenerator: makeIdGen() });
  const sttListingSnapshots = new SttListingSnapshotStore(db, { clock: fixedClock });
  const app = createSttRoutes(new SttAdapter({ stt, providers, tts, sttListingSnapshots }));
  return { app, stt, sttListingSnapshots, db };
}

type App = Awaited<ReturnType<typeof makeApp>>["app"];

async function seedProfile(
  app: App,
  overrides: { backend?: string; config?: Record<string, unknown>; apiKey?: string } = {},
): Promise<string> {
  const res = await app.request("/api/stt/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Local",
      backend: overrides.backend ?? "openai-compat",
      config: overrides.config ?? { endpoint: ENDPOINT, model: "whisper-1" },
      ...(overrides.apiKey !== undefined ? { apiKey: overrides.apiKey } : {}),
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

function post(app: App, body: Record<string, unknown>) {
  return app.request("/api/stt/draft/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(app: App, id: string, body: Record<string, unknown>) {
  return app.request(`/api/stt/profiles/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** An OpenAI-compatible `/models` answer. */
function modelsAnswer(ids: string[]): Response {
  return Response.json({ data: ids.map((id) => ({ id })) });
}

const compatBody = (profileId: string | undefined, extra: Record<string, unknown> = {}) => ({
  backend: "openai-compat",
  config: { endpoint: ENDPOINT, model: "whisper-1" },
  ...(profileId !== undefined ? { profileId } : {}),
  ...extra,
});

const ids = async (res: Response) => ((await res.json()) as Array<{ id: string }>).map((m) => m.id);

describe("STT draft models — stored-first open path", () => {
  test("a stored list answers with zero upstream calls", async () => {
    const counter = installCountingTransport(() => modelsAnswer(["whisper-1", "whisper-large"]));
    const { app } = await makeApp();
    const id = await seedProfile(app);
    const live = await post(app, compatBody(id));
    expect(live.status).toBe(200);
    const liveBody = await live.json();
    const callsAfterLive = counter.calls;
    expect(callsAfterLive).toBeGreaterThan(0);

    const stored = await post(app, compatBody(id, { source: "stored" }));
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual(liveBody);
    expect(counter.calls).toBe(callsAfterLive);
  });

  test("nothing stored -> one live listing, recorded for the next open", async () => {
    const counter = installCountingTransport(() => modelsAnswer(["whisper-1"]));
    const { app, sttListingSnapshots } = await makeApp();
    const id = await seedProfile(app);
    expect(await sttListingSnapshots.get(id, "models")).toBeNull();

    const first = await post(app, compatBody(id, { source: "stored" }));
    expect(first.status).toBe(200);
    expect(counter.calls).toBe(1);
    expect(await sttListingSnapshots.get(id, "models")).not.toBeNull();

    const second = await post(app, compatBody(id, { source: "stored" }));
    expect(await second.json()).toEqual(await first.json());
    expect(counter.calls).toBe(1);
  });

  test("refresh (no source) lists live and overwrites; the next stored read shows the new roster", async () => {
    let roster = ["old-model"];
    const counter = installCountingTransport(() => modelsAnswer(roster));
    const { app } = await makeApp();
    const id = await seedProfile(app);
    await post(app, compatBody(id));

    roster = ["new-model"];
    const callsBefore = counter.calls;
    expect(await ids(await post(app, compatBody(id)))).toEqual(["new-model"]);
    expect(counter.calls).toBeGreaterThan(callsBefore);

    const callsAfterRefresh = counter.calls;
    expect(await ids(await post(app, compatBody(id, { source: "stored" })))).toEqual(["new-model"]);
    expect(counter.calls).toBe(callsAfterRefresh);
  });

  test("a config pointing at another endpoint is never read from or written under the profile", async () => {
    let roster = ["original"];
    const counter = installCountingTransport(() => modelsAnswer(roster));
    const { app, sttListingSnapshots } = await makeApp();
    const id = await seedProfile(app);
    await post(app, compatBody(id));
    const stored = await sttListingSnapshots.get(id, "models");

    // An unsaved edit that points elsewhere (the Test-connection button, the
    // local-server status chip): the stored list is not served for it...
    roster = ["from-elsewhere"];
    const callsBefore = counter.calls;
    const elsewhere = await post(app, {
      backend: "openai-compat",
      config: { endpoint: OTHER_ENDPOINT, model: "whisper-1" },
      profileId: id,
      source: "stored",
    });
    expect(elsewhere.status).toBe(200);
    expect(await ids(elsewhere)).toEqual(["from-elsewhere"]);
    expect(counter.calls).toBeGreaterThan(callsBefore);
    expect(counter.urls[counter.urls.length - 1]).toContain(OTHER_ENDPOINT);

    // ...and its answer is not written under the profile.
    expect(await sttListingSnapshots.get(id, "models")).toEqual(stored);
  });

  test("a different backend with the profile's id is never written under the profile", async () => {
    installCountingTransport(() => Response.json({ models: [{ name: "models/gemini-3.8-flash" }] }));
    const { app, sttListingSnapshots } = await makeApp();
    const id = await seedProfile(app);

    const res = await post(app, { backend: "gemini", config: { apiKey: "g-key" }, profileId: id });
    expect(res.status).toBe(200);
    expect(await sttListingSnapshots.get(id, "models")).toBeNull();
  });

  test("a vendor-keyed backend (gemini, no endpoint) matches its saved profile by backend alone", async () => {
    const counter = installCountingTransport(() => Response.json({ models: [{ name: "models/gemini-3.8-flash" }] }));
    const { app, sttListingSnapshots } = await makeApp();
    const id = await seedProfile(app, { backend: "gemini", config: { model: "gemini-3.8-flash" }, apiKey: "g-key" });
    const body = { backend: "gemini", config: { model: "gemini-3.8-flash" }, profileId: id };

    expect(await ids(await post(app, body))).toEqual(["gemini-3.8-flash"]);
    expect(await sttListingSnapshots.get(id, "models")).not.toBeNull();
    const callsAfterLive = counter.calls;

    expect(await ids(await post(app, { ...body, source: "stored" }))).toEqual(["gemini-3.8-flash"]);
    expect(counter.calls).toBe(callsAfterLive);
  });

  test("an unknown profile id and a brand-new profile (no id) list live and store nothing", async () => {
    const counter = installCountingTransport(() => modelsAnswer(["whisper-1"]));
    const { app, db } = await makeApp();

    expect((await post(app, compatBody(undefined, { source: "stored" }))).status).toBe(200);
    expect((await post(app, compatBody("stt_profile_missing", { source: "stored" }))).status).toBe(200);

    expect(counter.calls).toBe(2);
    expect(await db.select().from(sttListingSnapshotRows)).toHaveLength(0);
  });

  test("renaming keeps the stored list; a changed endpoint drops it and the next open lists the new server live", async () => {
    const counter = installCountingTransport(() => modelsAnswer(["whisper-1"]));
    const { app, sttListingSnapshots } = await makeApp();
    const id = await seedProfile(app);
    await post(app, compatBody(id));

    expect((await patch(app, id, { name: "Renamed" })).status).toBe(200);
    expect(await sttListingSnapshots.get(id, "models")).not.toBeNull();

    expect((await patch(app, id, { config: { endpoint: OTHER_ENDPOINT, model: "whisper-1" } })).status).toBe(200);
    expect(await sttListingSnapshots.get(id, "models")).toBeNull();

    const callsBefore = counter.calls;
    const reopened = await post(app, {
      backend: "openai-compat",
      config: { endpoint: OTHER_ENDPOINT, model: "whisper-1" },
      profileId: id,
      source: "stored",
    });
    expect(reopened.status).toBe(200);
    expect(counter.calls).toBeGreaterThan(callsBefore);
  });

  test("a changed backend drops the stored list", async () => {
    installCountingTransport(() => modelsAnswer(["whisper-1"]));
    const { app, sttListingSnapshots } = await makeApp();
    const id = await seedProfile(app);
    await post(app, compatBody(id));
    expect(await sttListingSnapshots.get(id, "models")).not.toBeNull();

    expect((await patch(app, id, { backend: "gemini", config: { model: "gemini-3.8-flash" } })).status).toBe(200);

    expect(await sttListingSnapshots.get(id, "models")).toBeNull();
  });

  test("an unreadable stored payload counts as nothing stored (live path, then rewritten)", async () => {
    const counter = installCountingTransport(() => modelsAnswer(["whisper-1"]));
    const { app, sttListingSnapshots } = await makeApp();
    const id = await seedProfile(app);
    await sttListingSnapshots.put(id, "models", { not: "a model list" });

    const res = await post(app, compatBody(id, { source: "stored" }));
    expect(res.status).toBe(200);
    expect(counter.calls).toBe(1);
    expect(await ids(res)).toEqual(["whisper-1"]);
    expect((await sttListingSnapshots.get(id, "models"))!.payload).toEqual([{ id: "whisper-1", label: "whisper-1" }]);
  });

  test("a failed live listing surfaces as before and leaves the stored list untouched (no failure fallback)", async () => {
    let up = true;
    installCountingTransport(() => (up ? modelsAnswer(["whisper-1"]) : new Response("boom", { status: 503 })));
    const { app, sttListingSnapshots } = await makeApp();
    const id = await seedProfile(app);
    await post(app, compatBody(id));
    const stored = await sttListingSnapshots.get(id, "models");

    up = false;
    expect((await post(app, compatBody(id))).status).toBe(502);
    expect(await sttListingSnapshots.get(id, "models")).toEqual(stored);

    // The open path still answers from storage while the server is down.
    expect((await post(app, compatBody(id, { source: "stored" }))).status).toBe(200);
  });

  test("whisper-browser keeps its 400 (fixed local roster) on the open path and stores nothing", async () => {
    const { app, db } = await makeApp();
    const id = await seedProfile(app, { backend: "whisper-browser", config: { model: "onnx-community/whisper-base" } });

    const res = await post(app, {
      backend: "whisper-browser",
      config: { model: "onnx-community/whisper-base" },
      profileId: id,
      source: "stored",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("model listing not supported");
    expect(await db.select().from(sttListingSnapshotRows)).toHaveLength(0);
  });

  // A probe-only backend (no listModels) answers [] after a green probe; the
  // route returns that, so that is what is recorded. An EMPTY stored list
  // counts as nothing stored (the LLM picker rule `cachedModels.length > 0`),
  // so the open path still probes live instead of answering [] unprobed.
  test("a probe-only backend's empty answer is recorded but the open path probes live; a failed probe stores nothing", async () => {
    let healthy = true;
    const counter = installCountingTransport(() =>
      healthy ? Response.json({ voices: [] }) : new Response("nope", { status: 401 }),
    );
    const { app, sttListingSnapshots } = await makeApp();
    const id = await seedProfile(app, { backend: "elevenlabs", config: { model: "scribe_v1" }, apiKey: "xi-key" });
    const body = { backend: "elevenlabs", config: { model: "scribe_v1" }, profileId: id };

    expect(await (await post(app, body)).json()).toEqual([]);
    expect((await sttListingSnapshots.get(id, "models"))!.payload).toEqual([]);
    const callsAfterLive = counter.calls;
    expect(await (await post(app, { ...body, source: "stored" })).json()).toEqual([]);
    expect(counter.calls).toBeGreaterThan(callsAfterLive);

    healthy = false;
    expect((await post(app, body)).status).toBe(400);
    expect((await sttListingSnapshots.get(id, "models"))!.payload).toEqual([]);
  });

  test("an unknown source value is a 400", async () => {
    installCountingTransport(() => modelsAnswer(["whisper-1"]));
    const { app } = await makeApp();
    const id = await seedProfile(app);
    expect((await post(app, compatBody(id, { source: "cache" }))).status).toBe(400);
  });
});
