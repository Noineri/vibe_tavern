/**
 * Image-gen routes tests (IMAGE_GENERATION_PLAN IG-8) — mirror of
 * stt-routes.test.ts: real on-disk SQLite (the generate path persists real
 * assets) + real adapter + real routes. The ONLY double is the transport:
 * bun:test `mock()` passed through the adapter's constructor `fetchOverride`
 * seam (tier T1 — no globalThis.fetch patching, no restore discipline
 * needed), so every backend HTTP call (probe/models/samplers/generate and
 * the adapters' server-side image download) runs through it.
 *
 * Covers: profile CRUD with the hasStoredApiKey projection (the secret never
 * crosses a read), the tri-state/nullable-clear update rules, probe
 * data-only failures, live model discovery with enrichment, the samplers
 * capability gate, the draft endpoint-guarded stored-key reuse, the generate
 * happy path (effective-parameter merge: overrides > mode preset > profile
 * defaults > vendor default), the image message slot + flat-asset
 * persistence, the error ladder (config/size → 400, upstream 4xx → 400,
 * 5xx/transport → 502), and gallery promotion.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import { AssetService } from "../src/domain/asset/asset-service.js";
import { ImageGenAdapter } from "../src/api/adapters/image-gen-adapter.js";
import { createImageGenRoutes } from "../src/api/routes/image-gen.js";
import { openRouterImageGenFactory } from "../src/domain/imagegen/backends/openrouter.js";
import { openAiImagesFactory } from "../src/domain/imagegen/backends/openai-images.js";
import { a1111Factory } from "../src/domain/imagegen/backends/a1111.js";
import {
  IMAGE_GEN_BACKEND_CAPABILITIES,
  __resetImageGenRegistryForTests,
  __restoreImageGenRegistryForTests,
  __snapshotImageGenRegistryForTests,
  registerImageGenBackend,
} from "../src/domain/imagegen/imagegen-registry.js";

// THE REGISTRY IS PROCESS-GLOBAL (mock.module gotcha applies to bun:test):
// imagegen-registry.test.ts runs `__resetImageGenRegistryForTests()` in the
// SAME process, wiping the factories the adapter registers at import time.
// Re-register the real factories in beforeEach so this file is
// order-independent, and restore the snapshot in afterAll (the stt-routes
// pattern).
const registrySnapshot = __snapshotImageGenRegistryForTests();

afterAll(() => {
  __restoreImageGenRegistryForTests(registrySnapshot);
});

beforeEach(() => {
  __resetImageGenRegistryForTests();
  registerImageGenBackend(IMAGE_GEN_BACKENDS.OpenRouter, openRouterImageGenFactory);
  registerImageGenBackend(IMAGE_GEN_BACKENDS.OpenAiImages, openAiImagesFactory);
  registerImageGenBackend(IMAGE_GEN_BACKENDS.A1111, a1111Factory);
});

/** Distinct PNG-signatured bytes so disk round-trips are verifiable. */
const PNG_BYTES = (tag: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag, tag, tag, tag]);
const PNG_B64 = (tag: number) => Buffer.from(PNG_BYTES(tag)).toString("base64");

type FetchArgs = Parameters<typeof fetch>;

interface AppFixture {
  app: ReturnType<typeof createImageGenRoutes>;
  stores: StoreContainer;
  assetService: AssetService;
  dataRoot: string;
}

/** Build the real stack (disk DB + assets) around an optional fetch double. */
async function makeApp(transport?: (input: FetchArgs[0], init?: FetchArgs[1]) => Promise<Response>): Promise<AppFixture> {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-imagegen-routes-"));
  const assetsDir = join(dataRoot, "assets");
  await mkdir(assetsDir, { recursive: true });
  const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  const assetService = new AssetService(assetsDir, stores.content);
  const adapter = new ImageGenAdapter(stores, assetService, transport);
  const app = createImageGenRoutes(adapter);
  return { app, stores, assetService, dataRoot };
}

/** A chat row (needs a character for the FK). */
async function makeChat(stores: StoreContainer): Promise<string> {
  const char = await stores.characters.create({ name: "Test" });
  const chat = await stores.chats.createChat({
    characterId: char.id,
    title: "t",
    promptPresetId: null,
  });
  return chat.id;
}

interface ProfileSeed {
  backend?: string;
  endpoint?: string;
  apiKey?: string;
  modelId?: string;
  defaultParams?: Record<string, number | string>;
  modeSizePresets?: Record<string, { width?: number; height?: number }>;
}

/** Create a profile through the route (exercises the create schema too). */
async function seedProfile(app: ReturnType<typeof createImageGenRoutes>, seed: ProfileSeed = {}): Promise<string> {
  const res = await app.request("/api/image-gen/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Test profile",
      backend: seed.backend ?? IMAGE_GEN_BACKENDS.OpenRouter,
      endpoint: seed.endpoint ?? "http://localhost:8000/v1",
      ...(seed.apiKey !== undefined ? { apiKey: seed.apiKey } : {}),
      ...(seed.modelId !== undefined ? { modelId: seed.modelId } : {}),
      defaultParams: seed.defaultParams ?? {},
      modeSizePresets: seed.modeSizePresets ?? {},
      // The registry's static snapshot — exactly what the Providers editor
      // persists (the create schema requires the flags object).
      capabilities: IMAGE_GEN_BACKEND_CAPABILITIES[(seed.backend ?? IMAGE_GEN_BACKENDS.OpenRouter) as keyof typeof IMAGE_GEN_BACKEND_CAPABILITIES],
    }),
  });
  expect(res.status).toBe(201);
  const created = (await res.json()) as { id: string };
  return created.id;
}

/** OpenAI-compat models catalog response body. */
function modelsBody(): Response {
  return new Response(
    JSON.stringify({
      data: [
        { id: "gpt-image-2", name: "GPT Image 2" },
        { id: "or-free", description: "free tier", pricing: { prompt: "0", completion: "0" } },
      ],
    }),
    { status: 200 },
  );
}

describe("image-gen routes — profile CRUD", () => {
  test("POST → 201; apiKey write-only (hasStoredApiKey, secret never on the wire); GET :id + all", async () => {
    const { app } = await makeApp();
    const createdRes = await app.request("/api/image-gen/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Forge — local",
        backend: IMAGE_GEN_BACKENDS.OpenRouter,
        endpoint: "http://localhost:8000/v1",
        apiKey: "sk-secret",
        modelId: "gpt-image-2",
        defaultParams: {},
        modeSizePresets: {},
        capabilities: IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.OpenRouter],
      }),
    });
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as { id: string; hasStoredApiKey: boolean; modelId?: string };
    expect(created.hasStoredApiKey).toBe(true);
    expect(created.modelId).toBe("gpt-image-2");
    expect(JSON.stringify(created)).not.toContain("sk-secret");

    const getRes = await app.request(`/api/image-gen/profiles/${created.id}`);
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as { id: string }).id).toBe(created.id);

    const allRes = await app.request("/api/image-gen/profiles/all");
    expect(((await allRes.json()) as unknown[]).length).toBe(1);
  });

  test("PATCH unknown id → 404; DELETE → ok:true", async () => {
    const { app } = await makeApp();
    const patchRes = await app.request("/api/image-gen/profiles/missing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(patchRes.status).toBe(404);
    const delRes = await app.request("/api/image-gen/profiles/missing", { method: "DELETE" });
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("PATCH tri-state: apiKey \"\" clears the stored key; modelId null clears the pointer", async () => {
    const { app } = await makeApp();
    const id = await seedProfile(app, { apiKey: "sk-secret", modelId: "gpt-image-2" });

    const patchRes = await app.request(`/api/image-gen/profiles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "", modelId: null }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { hasStoredApiKey: boolean; modelId?: string };
    expect(patched.hasStoredApiKey).toBe(false);
    expect(patched.modelId).toBeUndefined();
  });
});

describe("image-gen routes — probe", () => {
  test("unknown profile → 404", async () => {
    const { app } = await makeApp();
    const res = await app.request("/api/image-gen/profiles/missing/probe", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("happy path → ok with the image-model count (documented endpoint + filter)", async () => {
    let capturedUrl = "";
    const { app } = await makeApp(async (input) => {
      capturedUrl = String(input);
      return modelsBody();
    });
    const id = await seedProfile(app, { apiKey: "sk-own" });

    const res = await app.request(`/api/image-gen/profiles/${id}/probe`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; detail?: string };
    expect(body.ok).toBe(true);
    expect(body.detail).toBe("2 image models");
    expect(capturedUrl).toBe("http://localhost:8000/v1/models?output_modalities=image");
  });

  test("upstream failure is DATA, never a throw: 401 → {ok:false, status:401}", async () => {
    const { app } = await makeApp(async () => new Response("bad key", { status: 401 }));
    const id = await seedProfile(app, { apiKey: "sk-bad" });

    const res = await app.request(`/api/image-gen/profiles/${id}/probe`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status?: number; detail?: string };
    expect(body.ok).toBe(false);
    expect(body.status).toBe(401);
    expect(body.detail).toContain("401");
  });
});

describe("image-gen routes — live model discovery", () => {
  test("catalog with enrichment; Authorization from the stored key; unknown profile → 404", async () => {
    let capturedAuth: string | undefined;
    const { app } = await makeApp(async (_input, init) => {
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      return modelsBody();
    });
    const id = await seedProfile(app, { apiKey: "sk-own" });

    const res = await app.request(`/api/image-gen/profiles/${id}/models`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string; label: string; isFree?: boolean }>;
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ id: "gpt-image-2", label: "GPT Image 2" });
    expect(list[1].isFree).toBe(true);
    expect(capturedAuth).toBe("Bearer sk-own");

    const missing = await app.request("/api/image-gen/profiles/missing/models");
    expect(missing.status).toBe(404);
  });

  test("upstream 503 → 502 through the route ladder (picker data never 500s)", async () => {
    const { app } = await makeApp(async () => new Response("boom", { status: 503 }));
    const id = await seedProfile(app, { apiKey: "sk-own" });
    const res = await app.request(`/api/image-gen/profiles/${id}/models`);
    expect(res.status).toBe(502);
  });
});

describe("image-gen routes — samplers (capability-gated)", () => {
  test("a1111 profile lists samplers via the documented endpoint", async () => {
    let capturedUrl = "";
    const { app } = await makeApp(async (input) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify([{ name: "Euler a", aliases: ["k_euler_a"] }, { name: "DPM++ 2M" }]),
        { status: 200 },
      );
    });
    const id = await seedProfile(app, { backend: IMAGE_GEN_BACKENDS.A1111, endpoint: "http://127.0.0.1:7860" });

    const res = await app.request(`/api/image-gen/profiles/${id}/samplers`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ name: string; aliases?: string[] }>;
    expect(list[0]).toEqual({ name: "Euler a", aliases: ["k_euler_a"] });
    expect(list[1]).toEqual({ name: "DPM++ 2M" });
    expect(capturedUrl).toBe("http://127.0.0.1:7860/sdapi/v1/samplers");
  });

  test("openrouter profile → 400 sampler listing not supported; unknown profile → 404", async () => {
    const { app } = await makeApp(async () => modelsBody());
    const id = await seedProfile(app, { backend: IMAGE_GEN_BACKENDS.OpenRouter });

    const gated = await app.request(`/api/image-gen/profiles/${id}/samplers`);
    expect(gated.status).toBe(400);
    expect(((await gated.json()) as { error: string }).error).toBe("sampler listing not supported");

    const missing = await app.request("/api/image-gen/profiles/missing/samplers");
    expect(missing.status).toBe(404);
  });
});

describe("image-gen routes — draft model listing (fetch-by-endpoint)", () => {
  test("form key rides through to the documented URL", async () => {
    let capturedUrl = "";
    let capturedAuth: string | undefined;
    const { app } = await makeApp(async (input, init) => {
      capturedUrl = String(input);
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      return modelsBody();
    });

    const res = await app.request("/api/image-gen/draft/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: IMAGE_GEN_BACKENDS.OpenRouter,
        config: { endpoint: "http://localhost:8000/v1", apiKey: "sk-form" },
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(2);
    expect(capturedUrl).toBe("http://localhost:8000/v1/models?output_modalities=image");
    expect(capturedAuth).toBe("Bearer sk-form");
  });

  test("profileId stored-key reuse is endpoint-guarded: match reuses, mismatch stays keyless", async () => {
    let capturedAuth: string | undefined;
    const { app } = await makeApp(async (_input, init) => {
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.["Authorization"];
      return modelsBody();
    });
    const id = await seedProfile(app, { endpoint: "http://localhost:8000/v1", apiKey: "sk-stored" });

    // Matching endpoint + no form key → stored key serves.
    const matchRes = await app.request("/api/image-gen/draft/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: IMAGE_GEN_BACKENDS.OpenRouter,
        config: { endpoint: "http://localhost:8000/v1" },
        profileId: id,
      }),
    });
    expect(matchRes.status).toBe(200);
    expect(capturedAuth).toBe("Bearer sk-stored");

    // Mismatched endpoint → the stored key must NOT serve.
    const mismatchRes = await app.request("/api/image-gen/draft/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: IMAGE_GEN_BACKENDS.OpenRouter,
        config: { endpoint: "http://elsewhere:9000/v1", apiKey: "sk-form" },
        profileId: id,
      }),
    });
    expect(mismatchRes.status).toBe(200);
    expect(capturedAuth).toBe("Bearer sk-form");
  });

  test("unknown backend slug → 400; upstream 401 → 400, 503 → 502", async () => {
    const { app } = await makeApp(async () => modelsBody());
    const unknown = await app.request("/api/image-gen/draft/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "no-such-backend", config: {} }),
    });
    expect(unknown.status).toBe(400);

    const authFail = await makeApp(async () => new Response("denied", { status: 401 }));
    const r401 = await authFail.app.request("/api/image-gen/draft/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: IMAGE_GEN_BACKENDS.OpenRouter,
        config: { endpoint: "http://localhost:8000/v1", apiKey: "k" },
      }),
    });
    expect(r401.status).toBe(400);

    const serverFail = await makeApp(async () => new Response("boom", { status: 503 }));
    const r503 = await serverFail.app.request("/api/image-gen/draft/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: IMAGE_GEN_BACKENDS.OpenRouter,
        config: { endpoint: "http://localhost:8000/v1", apiKey: "k" },
      }),
    });
    expect(r503.status).toBe(502);
  });
});

describe("image-gen routes — generate (image message slot)", () => {
  /** OpenRouter happy-path transport: one completions call + one data-URL download. */
  function openRouterTransport(captured: { url?: string; init?: RequestInit; calls: number }) {
    return mock(async (input: FetchArgs[0], init?: FetchArgs[1]) => {
      captured.calls += 1;
      const url = String(input);
      if (url.endsWith("/chat/completions")) {
        captured.url = url;
        captured.init = init;
        return new Response(
          JSON.stringify({
            choices: [
              { message: { role: "assistant", images: [{ image_url: { url: `data:image/png;base64,${PNG_B64(0x11)}` } }] } },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(PNG_BYTES(0x11), { status: 200, headers: { "Content-Type": "image/png" } });
    });
  }

  test("unknown chat → 404; unknown profile → 404", async () => {
    const { app, stores } = await makeApp(async () => {
      throw new TypeError("must not be called");
    });
    const chatId = await makeChat(stores);

    const noChat = await app.request(`/api/chats/missing/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "missing", mode: "portrait", prompt: "p" }),
    });
    expect(noChat.status).toBe(404);

    const noProfile = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "missing", mode: "portrait", prompt: "p" }),
    });
    expect(noProfile.status).toBe(404);
  });

  test("anchor message from another chat → 400", async () => {
    const { app, stores } = await makeApp(async () => modelsBody());
    const chatId = await makeChat(stores);
    const otherChatId = await makeChat(stores);
    const other = await stores.messages.addMessage({
      chatId: otherChatId,
      branchId: (await stores.chats.getById(otherChatId))!.activeBranchId as string,
      role: "user",
      authorType: "user",
      content: "hi",
    });
    const id = await seedProfile(app, { apiKey: "sk-own", modelId: "gpt-image-2" });

    const res = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "portrait", prompt: "p", anchorMessageId: other.id }),
    });
    expect(res.status).toBe(400);
  });

  test("happy path: wire body carries modalities + the mode-preset ratio; message slot appended with the attachment; bytes on disk", async () => {
    const captured = { calls: 0 };
    const { app, stores, assetService } = await makeApp(openRouterTransport(captured));
    const chatId = await makeChat(stores);
    const id = await seedProfile(app, {
      apiKey: "sk-own",
      modelId: "gpt-image-2",
      modeSizePresets: { portrait: { width: 832, height: 1248 } },
    });

    const res = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "portrait", prompt: "a quiet tavern" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messageId: string;
      mode: string;
      profileId: string;
      model?: string;
      width?: number;
      height?: number;
      attachments: Array<{ assetId: string; mimeType: string; sizeBytes: number }>;
    };
    expect(body.mode).toBe("portrait");
    expect(body.model).toBe("gpt-image-2");
    expect(body.width).toBe(832);
    expect(body.height).toBe(1248);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].mimeType).toBe("image/png");

    // Wire body: the documented transport + the mode preset's grid ratio.
    expect(captured.url).toBe("http://localhost:8000/v1/chat/completions");
    const wire = JSON.parse(String(captured.init?.body)) as {
      model: string;
      modalities: string[];
      image_config?: { aspect_ratio: string };
    };
    expect(wire.model).toBe("gpt-image-2");
    expect(wire.modalities).toEqual(["image", "text"]);
    expect(wire.image_config).toEqual({ aspect_ratio: "2:3" });

    // The message slot: assistant message, empty content, image attachment.
    const message = await stores.messages.getMessageById(body.messageId);
    expect(message).not.toBeNull();
    expect(message!.role).toBe("assistant");
    expect(message!.content).toBe("");
    const attachments = JSON.parse(message!.attachmentsJson ?? "[]") as Array<{ assetId: string; type: string; mimeType: string }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].assetId).toBe(body.attachments[0].assetId);
    expect(attachments[0].type).toBe("image");

    // The bytes persisted server-side (flat asset; URL never handed upward).
    const stored = await assetService.loadBuffer(body.attachments[0].assetId);
    expect(stored).not.toBeNull();
    expect(stored!.length).toBe(PNG_BYTES(0x11).length);
    // One completions call + one server-side download — nothing else.
    expect(captured.calls).toBe(2);
  });

  test("request overrides win over the mode preset", async () => {
    const captured = { calls: 0 };
    const { app, stores } = await makeApp(openRouterTransport(captured));
    const chatId = await makeChat(stores);
    const id = await seedProfile(app, {
      apiKey: "sk-own",
      modelId: "gpt-image-2",
      modeSizePresets: { portrait: { width: 832, height: 1248 } },
    });

    const res = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: id,
        mode: "portrait",
        prompt: "p",
        overrides: { width: 1344, height: 768, model: "override-model" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { width?: number; height?: number; model?: string };
    expect(body.width).toBe(1344);
    expect(body.height).toBe(768);
    expect(body.model).toBe("override-model");
    const wire = JSON.parse(String(captured.init?.body)) as { model: string; image_config?: { aspect_ratio: string } };
    expect(wire.model).toBe("override-model");
    expect(wire.image_config).toEqual({ aspect_ratio: "16:9" });
  });

  test("undocumented size → 400 BEFORE any transport call (fail-closed grid)", async () => {
    const captured = { calls: 0 };
    const { app, stores } = await makeApp(openRouterTransport(captured));
    const chatId = await makeChat(stores);
    const id = await seedProfile(app, { apiKey: "sk-own", modelId: "gpt-image-2" });

    const res = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: id,
        mode: "portrait",
        prompt: "p",
        overrides: { width: 999, height: 999 },
      }),
    });
    expect(res.status).toBe(400);
    const errBody = (await res.json()) as { error: string };
    expect(errBody.error).toContain("999x999");
    expect(captured.calls).toBe(0);
  });

  test("upstream 500 → 502 through the route ladder", async () => {
    const { app, stores } = await makeApp(async () => new Response("boom", { status: 500 }));
    const chatId = await makeChat(stores);
    const id = await seedProfile(app, { apiKey: "sk-own", modelId: "gpt-image-2" });

    const res = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "portrait", prompt: "p" }),
    });
    expect(res.status).toBe(502);
  });
});

describe("image-gen routes — gallery promotion", () => {
  test("generated attachment promotes into the character gallery; message untouched", async () => {
    const captured = { calls: 0 };
    const transport = mock(async (input: FetchArgs[0], init?: FetchArgs[1]) => {
      captured.calls += 1;
      const url = String(input);
      if (url.endsWith("/chat/completions")) {
        captured.init = init;
        return new Response(
          JSON.stringify({
            choices: [
              { message: { role: "assistant", images: [{ image_url: { url: `data:image/png;base64,${PNG_B64(0x22)}` } }] } },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(PNG_BYTES(0x22), { status: 200, headers: { "Content-Type": "image/png" } });
    });
    const { app, stores, assetService } = await makeApp(transport);
    const char = await stores.characters.create({ name: "Test" });
    const chat = await stores.chats.createChat({ characterId: char.id, title: "t", promptPresetId: null });
    const id = await seedProfile(app, { apiKey: "sk-own", modelId: "gpt-image-2" });

    const genRes = await app.request(`/api/chats/${chat.id}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "portrait", prompt: "p" }),
    });
    expect(genRes.status).toBe(200);
    const gen = (await genRes.json()) as { messageId: string; attachments: Array<{ assetId: string }> };

    const promoteRes = await app.request(`/api/image-gen/attachments/${gen.attachments[0].assetId}/promote-to-gallery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ characterId: char.id }),
    });
    expect(promoteRes.status).toBe(201);
    const promoted = (await promoteRes.json()) as { assetRowId: string; characterId: string; ext: string; order: number };
    expect(promoted.characterId).toBe(char.id);
    expect(promoted.ext).toBe("png");
    expect(promoted.order).toBe(0);

    // The gallery row exists and the file is readable through the service.
    const rows = await stores.characterAssets.listByCharacter(char.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(promoted.assetRowId);
    const galleryBytes = await assetService.loadGalleryImageBuffer(char.id, promoted.assetRowId, promoted.ext);
    expect(galleryBytes).not.toBeNull();
    expect(galleryBytes!.length).toBe(PNG_BYTES(0x22).length);

    // The message's attachment is untouched (the flat asset still loads).
    const flat = await assetService.loadBuffer(gen.attachments[0].assetId);
    expect(flat).not.toBeNull();
  });

  test("unknown asset → 404", async () => {
    const { app, stores } = await makeApp(async () => modelsBody());
    const char = await stores.characters.create({ name: "Test" });
    const res = await app.request("/api/image-gen/attachments/missing/promote-to-gallery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ characterId: char.id }),
    });
    expect(res.status).toBe(404);
  });
});

describe("image-gen routes — model favorites + per-model settings (IG-12b)", () => {
  test("star → list → un-star round-trips; unknown profile 404s on every verb", async () => {
    const { app } = await makeApp();
    const id = await seedProfile(app, { backend: "a1111", endpoint: "http://127.0.0.1:7860" });

    const star = await app.request(`/api/image-gen/profiles/${id}/model-favorites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "sd_xl", label: "SD XL" }),
    });
    expect(star.status).toBe(201);
    const starred = (await star.json()) as { modelId: string; label: string | null; profileId: string };
    expect(starred.modelId).toBe("sd_xl");
    expect(starred.label).toBe("SD XL");
    expect(starred.profileId).toBe(id);

    const list = await app.request(`/api/image-gen/profiles/${id}/model-favorites`);
    expect(list.status).toBe(200);
    expect(((await list.json()) as unknown[]).length).toBe(1);

    const unstar = await app.request(`/api/image-gen/profiles/${id}/model-favorites`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "sd_xl" }),
    });
    expect(unstar.status).toBe(200);

    const empty = await app.request(`/api/image-gen/profiles/${id}/model-favorites`);
    expect(((await empty.json()) as unknown[]).length).toBe(0);

    for (const [method, path] of [
      ["GET", "/api/image-gen/profiles/missing/model-favorites"],
      ["POST", "/api/image-gen/profiles/missing/model-favorites"],
      ["DELETE", "/api/image-gen/profiles/missing/model-favorites"],
      ["GET", "/api/image-gen/profiles/missing/model-settings"],
      ["GET", "/api/image-gen/profiles/missing/model-settings/m"],
      ["PUT", "/api/image-gen/profiles/missing/model-settings/m"],
      ["DELETE", "/api/image-gen/profiles/missing/model-settings/m"],
    ] as const) {
      const res = await app.request(path, {
        method,
        ...(method !== "GET" && method !== "DELETE"
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelId: "m" }) }
          : method === "DELETE"
            ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelId: "m" }) }
            : {}),
      });
      expect(res.status).toBe(404);
    }
  });

  test("overlay PUT → GET → DELETE round-trips through the API; a model without an overlay GETs null", async () => {
    const { app } = await makeApp();
    const id = await seedProfile(app, { backend: "a1111", endpoint: "http://127.0.0.1:7860" });

    const overlay = {
      steps: 30,
      sampler: "DPM++ 2M",
      modeSizePresets: { portrait: { width: 832, height: 1216 } },
    };
    const put = await app.request(`/api/image-gen/profiles/${id}/model-settings/sd_xl`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(overlay),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      profileId: id,
      modelId: "sd_xl",
      settings: overlay,
    });

    const get = await app.request(`/api/image-gen/profiles/${id}/model-settings/sd_xl`);
    expect(get.status).toBe(200);
    expect(((await get.json()) as { settings: typeof overlay }).settings).toEqual(overlay);

    const list = await app.request(`/api/image-gen/profiles/${id}/model-settings`);
    expect(((await list.json()) as unknown[]).length).toBe(1);

    const absent = await app.request(`/api/image-gen/profiles/${id}/model-settings/other`);
    expect(absent.status).toBe(200);
    expect(await absent.json()).toBe(null);

    const del = await app.request(`/api/image-gen/profiles/${id}/model-settings/sd_xl`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = await app.request(`/api/image-gen/profiles/${id}/model-settings/sd_xl`);
    expect(await after.json()).toBe(null);
  });

  test("an overlay with an unknown mode key is rejected by the contract (422)", async () => {
    const { app } = await makeApp();
    const id = await seedProfile(app, { backend: "a1111", endpoint: "http://127.0.0.1:7860" });
    const res = await app.request(`/api/image-gen/profiles/${id}/model-settings/sd_xl`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modeSizePresets: { "not-a-mode": { width: 512 } } }),
    });
    expect(res.status).toBe(400);
  });
});
