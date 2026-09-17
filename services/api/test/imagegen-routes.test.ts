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
 * 5xx/transport → 502), gallery promotion, and the IG-14 mode assembly
 * (six server-built prompts, override-beats-builtin, the negative
 * capability gate, slot provenance, RP-prompt separation).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, ServicePromptProfileStore, UiSettingsStore, type StoreContainer } from "@vibe-tavern/db";
import { domainErrorToJson, httpStatusForDomainError, isDomainError } from "../src/shared/errors.js";
import { IMAGE_GEN_BACKENDS, parseStoredAttachments, type ChatId } from "@vibe-tavern/domain";

import { AssetService } from "../src/domain/asset/asset-service.js";
import { ImageGenAdapter, type ImageGenAssistDeps } from "../src/api/adapters/image-gen-adapter.js";
import type { ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";
import { ProviderExecutionError } from "../src/infrastructure/ai/provider-execution-types.js";
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";
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
import { PromptAssemblyService, type PromptAssemblyResolver } from "../src/domain/prompt/prompt-assembly-service.js";

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

/** Build the real stack (disk DB + assets) around an optional fetch double
 *  and optional IG-15 assist deps (the quiet-call DI seam). */
async function makeApp(
  transport?: (input: FetchArgs[0], init?: FetchArgs[1]) => Promise<Response>,
  assistDeps?: ImageGenAssistDeps,
): Promise<AppFixture> {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-imagegen-routes-"));
  const assetsDir = join(dataRoot, "assets");
  await mkdir(assetsDir, { recursive: true });
  const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  const assetService = new AssetService(assetsDir, stores.content);
  const adapter = new ImageGenAdapter(stores, assetService, transport, assistDeps);
  const app = createImageGenRoutes(adapter);
  // The production onError mounts in app-factory; surface the same DomainError
  // mapping here so 409 (set-name collision) / 400 (validation) pin their real
  // statuses instead of 500 (the sampler-set-routes test pattern).
  app.onError((err, c) => {
    if (isDomainError(err)) {
      return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
    }
    return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
  });
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
  userSizes?: Array<{ width: number; height: number; ratio?: string }>;
  llmAssistEnabled?: boolean;
  llmProviderProfileId?: string;
  llmModelId?: string;
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
      ...(seed.userSizes !== undefined ? { userSizes: seed.userSizes } : {}),
      ...(seed.llmAssistEnabled !== undefined ? { llmAssistEnabled: seed.llmAssistEnabled } : {}),
      ...(seed.llmProviderProfileId !== undefined ? { llmProviderProfileId: seed.llmProviderProfileId } : {}),
      ...(seed.llmModelId !== undefined ? { llmModelId: seed.llmModelId } : {}),
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

  test("IG-20a: user size entries ride the CRUD round-trip (create carries, PATCH replaces, PATCH [] clears)", async () => {
    const { app } = await makeApp();
    const id = await seedProfile(app, {
      userSizes: [
        { width: 1152, height: 896, ratio: "9:7" },
        { width: 1216, height: 896 },
      ],
    });

    const getRes = await app.request(`/api/image-gen/profiles/${id}`);
    expect(getRes.status).toBe(200);
    const created = (await getRes.json()) as { userSizes?: Array<{ width: number; height: number; ratio?: string }> };
    expect(created.userSizes).toEqual([
      { width: 1152, height: 896, ratio: "9:7" },
      { width: 1216, height: 896 },
    ]);

    const patchRes = await app.request(`/api/image-gen/profiles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userSizes: [{ width: 1024, height: 576, ratio: "16:9" }] }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { userSizes?: unknown[] };
    expect(patched.userSizes).toEqual([{ width: 1024, height: 576, ratio: "16:9" }]);

    const clearRes = await app.request(`/api/image-gen/profiles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userSizes: [] }),
    });
    expect(clearRes.status).toBe(200);
    const cleared = (await clearRes.json()) as { userSizes?: unknown[] };
    expect(cleared.userSizes).toBeUndefined();
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

describe("image-gen routes — IG-21 auto-key cascade", () => {
  /** Seed a keyful LLM provider profile (the cascade's match pool). */
  async function seedProvider(
    stores: StoreContainer,
    seed: { name: string; endpoint: string; apiKey: string },
  ): Promise<void> {
    await stores.providers.create({
      name: seed.name,
      providerPreset: "custom",
      endpoint: seed.endpoint,
      apiKey: seed.apiKey,
    });
  }

  test("keyless openrouter profile + keyful provider on the vendor host → generation rides the provider key", async () => {
    const captured: { init?: RequestInit; calls: number } = { calls: 0 };
    const { app, stores } = await makeApp(openRouterTransport(captured));
    await seedProvider(stores, { name: "OR main", endpoint: "https://openrouter.ai/api/v1", apiKey: "sk-provider" });
    const chatId = await makeChat(stores);
    const id = await seedProfile(app, {
      endpoint: "https://openrouter.ai/api/v1",
      modelId: "gpt-image-2",
      modeSizePresets: { portrait: { width: 1024, height: 1024 } },
    });

    const res = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "portrait", prompt: "p" }),
    });
    expect(res.status).toBe(200);
    const auth = (captured.init?.headers as Record<string, string> | undefined)?.["Authorization"];
    expect(auth).toBe("Bearer sk-provider");
  });

  test("own key wins over the auto-match (the provider key never rides)", async () => {
    const captured: { init?: RequestInit; calls: number } = { calls: 0 };
    const { app, stores } = await makeApp(openRouterTransport(captured));
    await seedProvider(stores, { name: "OR main", endpoint: "https://openrouter.ai/api/v1", apiKey: "sk-provider" });
    const chatId = await makeChat(stores);
    const id = await seedProfile(app, {
      endpoint: "https://openrouter.ai/api/v1",
      apiKey: "sk-own",
      modelId: "gpt-image-2",
      modeSizePresets: { portrait: { width: 1024, height: 1024 } },
    });

    const res = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "portrait", prompt: "p" }),
    });
    expect(res.status).toBe(200);
    const auth = (captured.init?.headers as Record<string, string> | undefined)?.["Authorization"];
    expect(auth).toBe("Bearer sk-own");
  });

  test("keyless profile with no matching provider → today's keyless error (fail-closed)", async () => {
    const { app, stores } = await makeApp(async () => new Response("unused", { status: 200 }));
    await seedProvider(stores, { name: "Elsewhere", endpoint: "https://api.other-vendor.test/v1", apiKey: "sk-provider" });
    const chatId = await makeChat(stores);
    const id = await seedProfile(app, { modelId: "gpt-image-2" });

    const res = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "portrait", prompt: "p" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("`apiKey` is required");
  });

  test("openai-images: exact endpoint match auto-keys; a different endpoint stays keyless", async () => {
    const captured: { init?: RequestInit; calls: number } = { calls: 0 };
    const { app, stores } = await makeApp(async (input, init) => {
      captured.init = init;
      const url = String(input);
      if (url.endsWith("/images/generations")) {
        return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64(0x51) }] }), { status: 200 });
      }
      return new Response(PNG_BYTES(0x51), { status: 200, headers: { "Content-Type": "image/png" } });
    });
    await seedProvider(stores, { name: "OAi main", endpoint: "https://api.openai.com/v1", apiKey: "sk-provider" });
    const chatId = await makeChat(stores);
    const matched = await seedProfile(app, {
      backend: IMAGE_GEN_BACKENDS.OpenAiImages,
      endpoint: "https://api.openai.com/v1",
      modelId: "gpt-image-2",
      modeSizePresets: { portrait: { width: 1024, height: 1024 } },
    });

    const ok = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: matched, mode: "portrait", prompt: "p" }),
    });
    expect(ok.status).toBe(200);
    const auth = (captured.init?.headers as Record<string, string> | undefined)?.["Authorization"];
    expect(auth).toBe("Bearer sk-provider");

    // Same backend, DIFFERENT endpoint — the openai-compat rule is EXACT:
    // no match, fail closed with the backend's auth config error.
    const elsewhere = await seedProfile(app, {
      backend: IMAGE_GEN_BACKENDS.OpenAiImages,
      endpoint: "https://images.other-gateway.test/v1",
      modelId: "gpt-image-2",
      modeSizePresets: { portrait: { width: 1024, height: 1024 } },
    });
    const denied = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: elsewhere, mode: "portrait", prompt: "p" }),
    });
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: string }).error).toContain("`apiKey` is required");
  });

  test("wire hint: keyless openrouter profile names the provider; own-key and a1111 stay null", async () => {
    const { app, stores } = await makeApp();
    await seedProvider(stores, { name: "OR main", endpoint: "https://openrouter.ai/api/v1", apiKey: "sk-provider" });
    const keyless = await seedProfile(app, { endpoint: "https://openrouter.ai/api/v1" });
    const ownKey = await seedProfile(app, { endpoint: "https://openrouter.ai/api/v1", apiKey: "sk-own" });
    const local = await seedProfile(app, { backend: IMAGE_GEN_BACKENDS.A1111, endpoint: "http://127.0.0.1:7860" });

    const res = await app.request("/api/image-gen/profiles/all");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string; autoKeyProviderName: string | null }>;
    const byId = new Map(list.map((p) => [p.id, p.autoKeyProviderName]));
    expect(byId.get(keyless)).toBe("OR main");
    expect(byId.get(ownKey)).toBeNull();
    expect(byId.get(local)).toBeNull();
  });

  test("draft models: a keyless openrouter draft auto-matches the provider key", async () => {
    const captured: { init?: RequestInit; calls: number } = { calls: 0 };
    const { app, stores } = await makeApp(async (_input, init) => {
      captured.init = init;
      return modelsBody();
    });
    await seedProvider(stores, { name: "OR main", endpoint: "https://openrouter.ai/api/v1", apiKey: "sk-provider" });

    const res = await app.request("/api/image-gen/draft/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: IMAGE_GEN_BACKENDS.OpenRouter,
        config: { endpoint: "https://openrouter.ai/api/v1", model: "gpt-image-2" },
      }),
    });
    expect(res.status).toBe(200);
    const auth = (captured.init?.headers as Record<string, string> | undefined)?.["Authorization"];
    expect(auth).toBe("Bearer sk-provider");
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

describe("image-gen routes — progress + interrupt (PG-2, capability-gated)", () => {
  test("a1111 profile surfaces the progress snapshot (mapped field names)", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const { app } = await makeApp(async (input, init) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "GET";
      return new Response(
        JSON.stringify({ progress: 0.42, eta_relative: 7.5, state: "sampling…", current_image: "cHJldmlldw==" }),
        { status: 200 },
      );
    });
    const id = await seedProfile(app, { backend: IMAGE_GEN_BACKENDS.A1111, endpoint: "http://127.0.0.1:7860" });

    const res = await app.request(`/api/image-gen/profiles/${id}/progress`);
    expect(res.status).toBe(200);
    const snapshot = (await res.json()) as {
      progress: number;
      etaRelative?: number;
      state?: string;
      previewBase64?: string;
    };
    expect(snapshot).toEqual({ progress: 0.42, etaRelative: 7.5, state: "sampling…", previewBase64: "cHJldmlldw==" });
    expect(capturedUrl).toBe("http://127.0.0.1:7860/sdapi/v1/progress");
    expect(capturedMethod).toBe("GET");
  });

  test("a1111 interrupt POSTs the documented endpoint and returns 204", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const { app } = await makeApp(async (input, init) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "GET";
      return new Response(null, { status: 200 });
    });
    const id = await seedProfile(app, { backend: IMAGE_GEN_BACKENDS.A1111, endpoint: "http://127.0.0.1:7860" });

    const res = await app.request(`/api/image-gen/profiles/${id}/interrupt`, { method: "POST" });
    expect(res.status).toBe(204);
    expect(capturedUrl).toBe("http://127.0.0.1:7860/sdapi/v1/interrupt");
    expect(capturedMethod).toBe("POST");
  });

  test("cloud profile → 400 not supported; unknown profile → 404 (both routes)", async () => {
    const { app } = await makeApp(async () => modelsBody());
    const id = await seedProfile(app, { backend: IMAGE_GEN_BACKENDS.OpenRouter });

    const gatedProgress = await app.request(`/api/image-gen/profiles/${id}/progress`);
    expect(gatedProgress.status).toBe(400);
    expect(((await gatedProgress.json()) as { error: string }).error).toBe("live progress not supported");

    const gatedInterrupt = await app.request(`/api/image-gen/profiles/${id}/interrupt`, { method: "POST" });
    expect(gatedInterrupt.status).toBe(400);
    expect(((await gatedInterrupt.json()) as { error: string }).error).toBe("interrupt not supported");

    const missingProgress = await app.request("/api/image-gen/profiles/missing/progress");
    expect(missingProgress.status).toBe(404);
    const missingInterrupt = await app.request("/api/image-gen/profiles/missing/interrupt", { method: "POST" });
    expect(missingInterrupt.status).toBe(404);
  });
});

describe("image-gen routes — extensions (A1111-dialect feature detection)", () => {
  test("a1111 profile lists extension names via /sdapi/v1/extensions", async () => {
    let capturedUrl = "";
    const { app } = await makeApp(async (input) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify([
          { name: "adetailer", enabled: true },
          { name: "sd-webui-infinite-image-browsing", enabled: false },
        ]),
        { status: 200 },
      );
    });
    const id = await seedProfile(app, { backend: IMAGE_GEN_BACKENDS.A1111, endpoint: "http://127.0.0.1:7860" });

    const res = await app.request(`/api/image-gen/profiles/${id}/extensions`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as string[];
    expect(list).toEqual(["adetailer", "sd-webui-infinite-image-browsing"]);
    expect(capturedUrl).toBe("http://127.0.0.1:7860/sdapi/v1/extensions");
  });

  test("openrouter profile → 400 extension listing not supported; unknown profile → 404", async () => {
    const { app } = await makeApp(async () => modelsBody());
    const id = await seedProfile(app, { backend: IMAGE_GEN_BACKENDS.OpenRouter });

    const gated = await app.request(`/api/image-gen/profiles/${id}/extensions`);
    expect(gated.status).toBe(400);
    expect(((await gated.json()) as { error: string }).error).toBe("extension listing not supported");

    const missing = await app.request("/api/image-gen/profiles/missing/extensions");
    expect(missing.status).toBe(404);
  });
});

describe("image-gen routes — schedulers (PG-3, dialect-gated)", () => {
  test("a1111 profile lists schedulers via /sdapi/v1/schedulers (name+label mapped, malformed skipped)", async () => {
    let capturedUrl = "";
    const { app } = await makeApp(async (input) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify([
          { name: "Automatic", label: "Automatic", aliases: null, options: {} },
          { name: "Karras", label: "Karras" },
          { label: "no-name entry" },
          "garbage",
        ]),
        { status: 200 },
      );
    });
    const id = await seedProfile(app, { backend: IMAGE_GEN_BACKENDS.A1111, endpoint: "http://127.0.0.1:7860" });

    const res = await app.request(`/api/image-gen/profiles/${id}/schedulers`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ name: string; label?: string }>;
    expect(list).toEqual([
      { name: "Automatic", label: "Automatic" },
      { name: "Karras", label: "Karras" },
    ]);
    expect(capturedUrl).toBe("http://127.0.0.1:7860/sdapi/v1/schedulers");
  });

  test("cloud profile → 400 scheduler listing not supported; unknown profile → 404", async () => {
    const { app } = await makeApp(async () => modelsBody());
    const id = await seedProfile(app, { backend: IMAGE_GEN_BACKENDS.OpenRouter });

    const gated = await app.request(`/api/image-gen/profiles/${id}/schedulers`);
    expect(gated.status).toBe(400);
    expect(((await gated.json()) as { error: string }).error).toBe("scheduler listing not supported");

    const missing = await app.request("/api/image-gen/profiles/missing/schedulers");
    expect(missing.status).toBe(404);
  });

  test("generate: the ladder's scheduler rides the txt2img body + the slot provenance; absent → never sent", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const { app, stores } = await makeApp(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ images: [PNG_B64(0x61)] }), { status: 200 });
    });
    const chatId = await makeChat(stores);
    const withScheduler = await seedProfile(app, {
      backend: IMAGE_GEN_BACKENDS.A1111,
      endpoint: "http://127.0.0.1:7860",
      defaultParams: { scheduler: "karras" },
    });
    const without = await seedProfile(app, {
      backend: IMAGE_GEN_BACKENDS.A1111,
      endpoint: "http://127.0.0.1:7861",
    });

    const first = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: withScheduler, mode: "portrait", prompt: "p" }),
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: without, mode: "portrait", prompt: "p" }),
    });
    expect(second.status).toBe(200);

    // Wire: sent when the ladder produced a value, ABSENT otherwise (the
    // no-silent-defaults rule — the server's own default applies).
    expect(bodies[0]!.scheduler).toBe("karras");
    expect("scheduler" in bodies[1]!).toBe(false);

    // Provenance: params records the scheduler that was actually sent.
    const slot = await stores.messages.getMessageById(((await first.json()) as { messageId: string }).messageId);
    const attachments = JSON.parse(slot!.attachmentsJson ?? "[]") as Array<{
      imageGen?: { params: Record<string, unknown> };
    }>;
    expect(attachments[0]!.imageGen!.params.scheduler).toBe("karras");
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

/** OpenRouter happy-path transport (module-scoped, shared by the generate
 *  describes): one completions call + one data-URL download. */
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

describe("image-gen routes — generate (image message slot)", () => {
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

  test("IG-20a: a profile's user size entry extends the grid at generation (announced ratio on the wire)", async () => {
    const captured: { url?: string; init?: RequestInit; calls: number } = { calls: 0 };
    const { app, stores } = await makeApp(openRouterTransport(captured));
    const chatId = await makeChat(stores);
    const id = await seedProfile(app, {
      apiKey: "sk-own",
      modelId: "gpt-image-2",
      userSizes: [{ width: 1152, height: 896, ratio: "9:7" }],
    });

    const res = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: id,
        mode: "portrait",
        prompt: "p",
        overrides: { width: 1152, height: 896 },
      }),
    });
    expect(res.status).toBe(200);
    const wire = JSON.parse(String(captured.init?.body)) as { image_config?: { aspect_ratio: string } };
    expect(wire.image_config).toEqual({ aspect_ratio: "9:7" });
    const body = (await res.json()) as { width?: number; height?: number };
    expect(body.width).toBe(1152);
    expect(body.height).toBe(896);
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

/** Capture every wire prompt a generation sends (one entry per call). */
function promptCapturingTransport(sent: string[]): (input: FetchArgs[0], init?: FetchArgs[1]) => Promise<Response> {
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith("/chat/completions")) {
      const wire = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      sent.push(wire.messages[0]!.content);
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", images: [{ image_url: { url: `data:image/png;base64,${PNG_B64(0x31)}` } }] } }],
        }),
        { status: 200 },
      );
    }
    return new Response(PNG_BYTES(0x31), { status: 200, headers: { "Content-Type": "image/png" } });
  };
}

describe("image-gen routes — mode assembly (IG-14)", () => {
  // The design's six recipes built through the REAL stack — only the
  // transport is a double (the file's T1 seam): the request travels the
  // route → adapter → mode module → service-prompt resolver (real assets on
  // disk) → MacroEngine → real backend code → the captured wire body.

  const CHAR_NAME = "Seraphine";
  const CHAR_DESC = "silver-haired tavern keeper with a scar over one eye";
  const PERSONA_NAME = "Alex";
  const PERSONA_DESC = "wandering bard in a patched travelling cloak";
  const LAST_MSG = "The tavern door creaks open and cold rain follows a stranger inside.";

  interface SceneFixture {
    app: ReturnType<typeof createImageGenRoutes>;
    stores: StoreContainer;
    chatId: string;
    charId: string;
  }

  /** Character + bound persona + chat + one user message (the mode
   *  templates' substitution sources). */
  async function makeScene(transport: (input: FetchArgs[0], init?: FetchArgs[1]) => Promise<Response>): Promise<SceneFixture> {
    const base = await makeApp(transport);
    const char = await base.stores.characters.create({ name: CHAR_NAME, description: CHAR_DESC });
    const persona = await base.stores.personas.create({ name: PERSONA_NAME, description: PERSONA_DESC });
    const chat = await base.stores.chats.createChat({
      characterId: char.id,
      personaId: persona.id,
      title: "scene",
      promptPresetId: null,
    });
    await base.stores.messages.addMessage({
      chatId: chat.id,
      branchId: chat.activeBranchId as string,
      role: "user",
      authorType: "user",
      content: LAST_MSG,
    });
    return { app: base.app, stores: base.stores, chatId: chat.id, charId: char.id };
  }

  test("six modes build mode-correct prompts on the wire; no unresolved macros survive", async () => {
    const sent: string[] = [];
    const scene = await makeScene(promptCapturingTransport(sent));
    const id = await seedProfile(scene.app, { apiKey: "sk-own", modelId: "gpt-image-2" });

    const expectances: Record<string, string[]> = {
      portrait: [CHAR_NAME, CHAR_DESC],
      character: [CHAR_NAME, CHAR_DESC],
      "user-persona": [PERSONA_NAME, PERSONA_DESC],
      "scene-background": [LAST_MSG],
      "scene-illustration": [LAST_MSG],
      free: ["raw caller direction"],
    };
    for (const [mode, fragments] of Object.entries(expectances)) {
      const res = await scene.app.request(`/api/chats/${scene.chatId}/image-gen/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: id,
          mode,
          // free mode's payload; the template modes exercise the SERVER build
          ...(mode === "free" ? { prompt: "raw caller direction" } : {}),
        }),
      });
      expect(res.status, `mode ${mode}`).toBe(200);
    }
    expect(sent).toHaveLength(6);
    for (const [mode, fragments] of Object.entries(expectances)) {
      const prompt = sent[Object.keys(expectances).indexOf(mode)]!;
      for (const fragment of fragments) {
        expect(prompt, `mode ${mode}`).toContain(fragment);
      }
      expect(prompt, `mode ${mode}`).not.toContain("{{");
    }
    // The free template is a wrapper: the raw prompt rides WITH template
    // prose, not alone.
    expect(sent[5]).not.toBe("raw caller direction");
  });

  test("active-profile override beats the built-in template; macros still substitute inside it", async () => {
    const sent: string[] = [];
    const scene = await makeScene(promptCapturingTransport(sent));
    const id = await seedProfile(scene.app, { apiKey: "sk-own", modelId: "gpt-image-2" });

    // An images-family override carrying a marker macro — resolves through
    // the SAME active-profile path the other families ride.
    const profileStore = new ServicePromptProfileStore(scene.stores.db);
    const profileRow = await profileStore.createServicePromptProfile({
      name: "image overrides",
      overrides: { image_portrait: "MARKER-{{char}}-OVERRIDE" },
    });
    await new UiSettingsStore(scene.stores.db).update({ activeServicePromptProfileId: profileRow.id });

    const res = await scene.app.request(`/api/chats/${scene.chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "portrait" }),
    });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(`MARKER-${CHAR_NAME}-OVERRIDE`);

    // Reset the pointer so later suites in this process start clean.
    await new UiSettingsStore(scene.stores.db).update({ activeServicePromptProfileId: null });
  });

  test("free mode without a caller prompt → 400 (the raw prompt IS the payload)", async () => {
    const scene = await makeScene(async () => {
      throw new TypeError("must not be called");
    });
    const id = await seedProfile(scene.app, { apiKey: "sk-own", modelId: "gpt-image-2" });
    const res = await scene.app.request(`/api/chats/${scene.chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "free" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("free");
  });

  test("negative template rides only negative-capable backends; the chip's edit wins when it does", async () => {
    // A1111 (supportsNegativePrompt) — the resolved image_negative default
    // lands in the txt2img body as negative_prompt.
    const a1111Sent: Array<Record<string, unknown>> = [];
    const a1111Scene = await makeScene(async (_input, init) => {
      a1111Sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ images: [Buffer.from(PNG_BYTES(0x41)).toString("base64")] }), { status: 200 });
    });
    const a1111Id = await seedProfile(a1111Scene.app, { backend: "a1111", endpoint: "http://127.0.0.1:7860" });
    const a1111Res = await a1111Scene.app.request(`/api/chats/${a1111Scene.chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: a1111Id, mode: "portrait" }),
    });
    expect(a1111Res.status).toBe(200);
    expect(a1111Sent[0]!.negative_prompt).toContain("watermark");

    // The chip's negative edit replaces the template verbatim.
    const chipRes = await a1111Scene.app.request(`/api/chats/${a1111Scene.chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: a1111Id,
        mode: "portrait",
        overrides: { negativePrompt: "chip-no-capes" },
      }),
    });
    expect(chipRes.status).toBe(200);
    expect(a1111Sent[1]!.negative_prompt).toBe("chip-no-capes");

    // OpenRouter (no negative support) — the negative NEVER rides the wire,
    // not even a chip edit (the capability gate is the design's consumption
    // rule): the chip's text must not leak anywhere in the request body.
    const orBodies: string[] = [];
    const orScene = await makeScene(async (input, init) => {
      // Only bodied calls (the completions POST); the server-side image
      // download is a bodiless GET — excluded by design.
      if (init?.body !== undefined) orBodies.push(String(init.body));
      void input;
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", images: [{ image_url: { url: `data:image/png;base64,${PNG_B64(0x42)}` } }] } }],
        }),
        { status: 200 },
      );
    });
    const orId = await seedProfile(orScene.app, { apiKey: "sk-own", modelId: "gpt-image-2" });
    const orRes = await orScene.app.request(`/api/chats/${orScene.chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: orId, mode: "portrait", overrides: { negativePrompt: "chip-no-capes" } }),
    });
    expect(orRes.status).toBe(200);
    expect(orBodies).toHaveLength(1);
    expect(orBodies[0]).not.toContain("chip-no-capes");
    expect(orBodies[0]).not.toContain("watermark");
  });

  test("slot provenance: mode + profileId + model + effective params + backend-reported seed + the final assembled prompt stamped on the attachment", async () => {
    const sent: string[] = [];
    const scene = await makeScene(promptCapturingTransport(sent));
    const id = await seedProfile(scene.app, {
      apiKey: "sk-own",
      modelId: "gpt-image-2",
      modeSizePresets: { portrait: { width: 832, height: 1248 } },
      defaultParams: { steps: 30 },
    });

    const res = await scene.app.request(`/api/chats/${scene.chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: id,
        mode: "portrait",
        overrides: { model: "chip-model" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messageId: string };
    const message = await scene.stores.messages.getMessageById(body.messageId);
    const attachments = JSON.parse(message!.attachmentsJson ?? "[]") as Array<{
      imageGen?: {
        mode: string;
        profileId: string;
        model?: string;
        prompt?: string;
        params: Record<string, unknown>;
        seed?: number;
      };
    }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.imageGen).toEqual({
      mode: "portrait",
      profileId: id,
      model: "chip-model",
      // IG-CF6: the FINAL assembled image prompt — exactly the text the
      // backend received on the wire (template + macros resolved), stamped
      // so the slot can render it.
      prompt: sent[0],
      params: { width: 832, height: 1248, steps: 30 },
      // The openrouter transport double reports no seed — the field stays
      // absent, never invented.
    });
  });

  test("RP-prompt separation: the image prompt never enters the roleplay assembly", async () => {
    const sent: string[] = [];
    const scene = await makeScene(promptCapturingTransport(sent));
    const id = await seedProfile(scene.app, { apiKey: "sk-own", modelId: "gpt-image-2" });

    const profileStore = new ServicePromptProfileStore(scene.stores.db);
    const profileRow = await profileStore.createServicePromptProfile({
      name: "separation override",
      overrides: { image_portrait: "MARKER-{{description}}-OVERRIDE" },
    });
    await new UiSettingsStore(scene.stores.db).update({ activeServicePromptProfileId: profileRow.id });

    // Generate the image slot INTO the chat (the feature is fully engaged).
    const genRes = await scene.app.request(`/api/chats/${scene.chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "portrait" }),
    });
    expect(genRes.status).toBe(200);
    expect(sent[0]).toBe(`MARKER-${CHAR_DESC}-OVERRIDE`);

    // The roleplay assembly for the SAME chat (image slot now in its message
    // list): real stores + real assembly, only the resolver is the existing
    // sibling seam. The assembled prompt must contain the ordinary chat
    // content and NONE of the image prompt (design: "The image prompt never
    // enters the RP prompt").
    const character = await scene.stores.characters.getById(scene.charId);
    const resolver: PromptAssemblyResolver = {
      getCharacter: async () => ({
        id: character!.id,
        name: character!.name,
        description: character!.description,
        scenario: character!.defaultScenario,
        systemPrompt: null,
        personality: character!.personalitySummary,
        mesExample: null,
        postHistoryInstructions: null,
      }),
      getPersona: async () => null,
      getPromptPreset: async () => null,
      listActiveLoreEntries: async () => [],
      listRetrievedMemories: async () => [],
      executeScripts: async () => ({
        character: { personality: "", scenario: "" },
        injectedMessages: [],
        updatedScriptState: {},
        errors: [],
        scriptRuns: [],
      }),
      getToolInstructions: () => null,
    };
    const fileStore = {
      dataRoot: "/mock",
      resolvePath: (_folder: string, relativePath: string) => `/mock/${relativePath}`,
      readJson: async <T>() => null as T,
      writeJson: async () => {},
      asyncWriteJson: async () => {},
    };
    const assemblyService = new PromptAssemblyService(scene.stores, resolver, fileStore);
    const assembled = await assemblyService.assembleForChat({
      chatId: scene.chatId as ChatId,
      model: "test-model",
    });

    const serialized = JSON.stringify(assembled.prompt);
    expect(serialized).toContain(LAST_MSG); // sanity: the RP prompt DID assemble the chat
    expect(serialized).not.toContain("MARKER"); // the image prompt stayed out
    expect(serialized).not.toContain("OVERRIDE");

    await new UiSettingsStore(scene.stores.db).update({ activeServicePromptProfileId: null });
  });

  test("slot prompt visibility (IG-18): excluded from the RP assembly by default, included on the per-image opt-in", async () => {
    const scene = await makeScene(promptCapturingTransport([]));
    const id = await seedProfile(scene.app, { apiKey: "sk-own", modelId: "gpt-image-2" });

    // Generate a slot into the chat (default includeInPrompt: OFF).
    const genRes = await scene.app.request(`/api/chats/${scene.chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "portrait" }),
    });
    expect(genRes.status).toBe(200);
    const gen = (await genRes.json()) as { messageId: string; attachments: Array<{ assetId: string }> };
    const assetId = gen.attachments[0]!.assetId;

    const character = await scene.stores.characters.getById(scene.charId);
    const resolver: PromptAssemblyResolver = {
      getCharacter: async () => ({
        id: character!.id,
        name: character!.name,
        description: character!.description,
        scenario: character!.defaultScenario,
        systemPrompt: null,
        personality: character!.personalitySummary,
        mesExample: null,
        postHistoryInstructions: null,
      }),
      getPersona: async () => null,
      getPromptPreset: async () => null,
      listActiveLoreEntries: async () => [],
      listRetrievedMemories: async () => [],
      executeScripts: async () => ({
        character: { personality: "", scenario: "" },
        injectedMessages: [],
        updatedScriptState: {},
        errors: [],
        scriptRuns: [],
      }),
      getToolInstructions: () => null,
    };
    const fileStore = {
      dataRoot: "/mock",
      resolvePath: (_folder: string, relativePath: string) => `/mock/${relativePath}`,
      readJson: async <T>() => null as T,
      writeJson: async () => {},
      asyncWriteJson: async () => {},
    };
    const assemblyService = new PromptAssemblyService(scene.stores, resolver, fileStore);
    const assembleSerialized = async () =>
      JSON.stringify(
        (
          await assemblyService.assembleForChat({
            chatId: scene.chatId as ChatId,
            model: "test-model",
          })
        ).prompt,
      );

    // Default: the slot is pure illustration — its attachment never reaches
    // the assembled RP prompt (the image prompt never enters the RP prompt;
    // the pixels do not either).
    const excluded = await assembleSerialized();
    expect(excluded).toContain(LAST_MSG); // sanity: the RP prompt DID assemble
    expect(excluded).not.toContain(assetId);

    // Opt-in flips the flag → the described image rides the prompt like any
    // described attachment (the adapter enforces a description before this
    // point; the assembly only checks the flag).
    const slotMessage = await scene.stores.messages.getMessageById(gen.messageId);
    const stored = parseStoredAttachments(slotMessage!.attachmentsJson) ?? [];
    expect(stored[0]!.imageGen).toBeDefined(); // sanity: it IS a slot
    await scene.stores.messages.updateMessageAttachments(
      gen.messageId,
      JSON.stringify(stored.map((a) => ({ ...a, includeInPrompt: true, description: a.description ?? "described" }))),
    );
    const included = await assembleSerialized();
    expect(included).toContain(assetId);
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
      const body =
        path.endsWith("/model-settings/m") && method === "PUT"
          ? { settings: {} } // IG-CF15 upsert body (values under `settings`)
          : { modelId: "m" };
      const res = await app.request(path, {
        method,
        ...(method !== "GET"
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
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
      body: JSON.stringify({ settings: overlay, samplerSetId: "set_1" }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      profileId: id,
      modelId: "sd_xl",
      settings: overlay,
      samplerSetId: "set_1",
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
      body: JSON.stringify({ settings: { modeSizePresets: { "not-a-mode": { width: 512 } } } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("image-gen routes — named sampler sets (IG-CF15)", () => {
  test("library CRUD round-trips; create/list order follows sortOrder; duplicate names 409", async () => {
    const { app } = await makeApp();

    const created = await app.request("/api/image-gen/sampler-sets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Crisp", payload: { steps: 30, sampler: "DPM++ 2M" } }),
    });
    expect(created.status).toBe(200);
    const first = (await created.json()) as { id: string; sortOrder: number; payload: Record<string, unknown> };
    expect(first.sortOrder).toBe(0);
    expect(first.payload).toEqual({ steps: 30, sampler: "DPM++ 2M" });

    const second = await app.request("/api/image-gen/sampler-sets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Soft", payload: { cfgScale: 5.5 } }),
    });
    const soft = (await second.json()) as { id: string; sortOrder: number };
    expect(soft.sortOrder).toBe(1);

    const list = await app.request("/api/image-gen/sampler-sets");
    expect(((await list.json()) as unknown[]).map((s) => (s as { name: string }).name)).toEqual(["Crisp", "Soft"]);

    // Duplicate name (case-insensitive) → 409 with the colliding id.
    const dup = await app.request("/api/image-gen/sampler-sets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  crisp ", payload: {} }),
    });
    expect(dup.status).toBe(409);

    // Rename + payload overwrite (the pencil / 💾 flows).
    const renamed = await app.request(`/api/image-gen/sampler-sets/${first.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Crispy", payload: { steps: 28 } }),
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: "Crispy", payload: { steps: 28 } });

    // Rename onto an existing name → 409; unknown set → 400.
    const clash = await app.request(`/api/image-gen/sampler-sets/${first.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Soft" }),
    });
    expect(clash.status).toBe(409);
    const missing = await app.request("/api/image-gen/sampler-sets/none", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    expect(missing.status).toBe(400);

    const del = await app.request(`/api/image-gen/sampler-sets/${soft.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = await app.request("/api/image-gen/sampler-sets");
    expect(((await after.json()) as unknown[]).length).toBe(1);
  });

  test("import accepts VT-native payload JSON and rejects empty/foreign shapes loudly", async () => {
    const { app } = await makeApp();

    const good = await app.request("/api/image-gen/sampler-sets/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Imported", raw: { steps: 25, seed: 123 } }),
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ set: { name: "Imported", payload: { steps: 25, seed: 123 } }, notes: [] });

    // An empty object would silently land as an empty set — must 400.
    const empty = await app.request("/api/image-gen/sampler-sets/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Empty", raw: {} }),
    });
    expect(empty.status).toBe(400);

    // A random JSON file (unknown keys only) also fails the payload schema.
    const foreign = await app.request("/api/image-gen/sampler-sets/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Foreign", raw: { totally: "unrelated" } }),
    });
    expect(foreign.status).toBe(400);
  });

  test("deleting a set clears overlay rows' pointers but keeps their applied values (LS-5e twin)", async () => {
    const { app } = await makeApp();
    const id = await seedProfile(app, { backend: "a1111", endpoint: "http://127.0.0.1:7860" });

    const set = (await (await app.request("/api/image-gen/sampler-sets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Crisp", payload: { steps: 30 } }),
    })).json()) as { id: string };

    const put = await app.request(`/api/image-gen/profiles/${id}/model-settings/sd_xl`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { steps: 30 }, samplerSetId: set.id }),
    });
    expect(put.status).toBe(200);

    const del = await app.request(`/api/image-gen/sampler-sets/${set.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const overlay = (await (await app.request(`/api/image-gen/profiles/${id}/model-settings/sd_xl`)).json()) as {
      settings: { steps?: number };
      samplerSetId: string | null;
    };
    expect(overlay.samplerSetId).toBe(null);
    expect(overlay.settings.steps).toBe(30);
  });

  test("overlay upsert pointer semantics: absent keeps, null clears, string sets", async () => {
    const { app } = await makeApp();
    const id = await seedProfile(app, { backend: "a1111", endpoint: "http://127.0.0.1:7860" });

    const put1 = await app.request(`/api/image-gen/profiles/${id}/model-settings/m1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { steps: 10 }, samplerSetId: "set_a" }),
    });
    expect(((await put1.json()) as { samplerSetId: string | null }).samplerSetId).toBe("set_a");

    // A values-only save must NOT wipe the pointer.
    const put2 = await app.request(`/api/image-gen/profiles/${id}/model-settings/m1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { steps: 20 } }),
    });
    expect(((await put2.json()) as { samplerSetId: string | null }).samplerSetId).toBe("set_a");

    // Explicit null clears it.
    const put3 = await app.request(`/api/image-gen/profiles/${id}/model-settings/m1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { steps: 20 }, samplerSetId: null }),
    });
    expect(((await put3.json()) as { samplerSetId: string | null }).samplerSetId).toBe(null);
  });
});

describe("image-gen routes — generate with the per-model overlay (IG-CF15)", () => {
  test("the ACTIVE model's overlay merges between request overrides and the profile base; another model's overlay never applies", async () => {
    const captured = { calls: 0 };
    const { app, stores } = await makeApp(openRouterTransport(captured));
    const chatId = await makeChat(stores);
    const id = await seedProfile(app, {
      apiKey: "sk-own",
      modelId: "gpt-image-2",
      modeSizePresets: { portrait: { width: 832, height: 1248 } },
    });

    // The active model's overlay: its mode preset beats the profile's own;
    // another model's overlay (with a DIFFERENT preset) must stay inert.
    const putActive = await app.request(`/api/image-gen/profiles/${id}/model-settings/gpt-image-2`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: { modeSizePresets: { portrait: { width: 1024, height: 1024 } } },
      }),
    });
    expect(putActive.status).toBe(200);
    const putOther = await app.request(`/api/image-gen/profiles/${id}/model-settings/other-model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: { modeSizePresets: { portrait: { width: 512, height: 512 } } },
      }),
    });
    expect(putOther.status).toBe(200);

    const res = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "portrait", prompt: "p" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { width?: number; height?: number; model?: string };
    expect(body.model).toBe("gpt-image-2");
    expect(body.width).toBe(1024);
    expect(body.height).toBe(1024);
    const wire = JSON.parse(String(captured.init?.body)) as { image_config?: { aspect_ratio: string } };
    expect(wire.image_config).toEqual({ aspect_ratio: "1:1" });

    // Request overrides still WIN over the overlay.
    captured.calls = 0;
    const res2 = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: id,
        mode: "portrait",
        prompt: "p",
        overrides: { width: 1344, height: 768 },
      }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { width?: number; height?: number };
    expect(body2.width).toBe(1344);
    expect(body2.height).toBe(768);
  });
});

describe("image-gen routes — generate with ADetailer (IG-CF15/PG-4 v1)", () => {
  /** One txt2img call answering with a single base64 PNG (the card's
   *  delivery shape; the bytes only need the PNG signature). */
  function txt2imgTransport(captured: { url?: string; init?: RequestInit }) {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.url = String(input);
      captured.init = init;
      return new Response(JSON.stringify({ images: [png.toString("base64")] }), { status: 200 });
    };
  }

  test("overlay adetailer:true sends the alwayson script with the chosen face model; disabled or unset sends none", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const { app, stores } = await makeApp(txt2imgTransport(captured));
    const chatId = await makeChat(stores);
    const id = await seedProfile(app, {
      backend: IMAGE_GEN_BACKENDS.A1111,
      endpoint: "http://127.0.0.1:7860",
      modelId: "sd_xl_refiner",
    });

    // Enabled WITH a chosen preset → the preset ships.
    const putOn = await app.request(`/api/image-gen/profiles/${id}/model-settings/sd_xl_refiner`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { adetailer: true, adetailerModel: "face_yolov8s.pt" } }),
    });
    expect(putOn.status).toBe(200);

    const res = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "free", prompt: "a portrait" }),
    });
    expect(res.status).toBe(200);
    expect(captured.url).toBe("http://127.0.0.1:7860/sdapi/v1/txt2img");
    let wire = JSON.parse(String(captured.init?.body)) as { alwayson_scripts?: unknown };
    expect(wire.alwayson_scripts).toEqual({
      ADetailer: { args: [true, { ad_model: "face_yolov8s.pt" }] },
    });

    // Enabled WITHOUT a preset → the domain default face model ships.
    await app.request(`/api/image-gen/profiles/${id}/model-settings/sd_xl_refiner`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { adetailer: true } }),
    });
    await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "free", prompt: "a portrait" }),
    });
    wire = JSON.parse(String(captured.init?.body)) as { alwayson_scripts?: unknown };
    expect(wire.alwayson_scripts).toEqual({
      ADetailer: { args: [true, { ad_model: "face_yolov8n.pt" }] },
    });

    // Flag off → nothing on the wire.
    await app.request(`/api/image-gen/profiles/${id}/model-settings/sd_xl_refiner`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { adetailer: false } }),
    });
    await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "free", prompt: "a portrait" }),
    });
    wire = JSON.parse(String(captured.init?.body)) as { alwayson_scripts?: unknown };
    expect("alwayson_scripts" in wire).toBe(false);
  });
});

describe("image-gen routes — generate LLM assist (IG-15)", () => {
  // The quiet pre-pass: assist deps injected through the constructor DI
  // seam (the adapter's ImageGenAssistDeps), the image backend still behind
  // the transport double — the executor double captures the (system, user,
  // model, profileId, signal) the runner assembles and returns a canned
  // refinement; the wire prompt then proves the refinement fed the macro
  // pass. Everything else (route → adapter → mode module → resolver →
  // MacroEngine → backend) is the REAL stack.

  /** Full StoredProviderProfileRecord — the runner reads providerPreset /
   *  apiKey / defaultModel / bindPerModel; the rest satisfy the type. */
  function makeLlmProfile(over: Partial<StoredProviderProfileRecord> = {}): StoredProviderProfileRecord {
    return {
      id: "llm1",
      name: "Writer LLM",
      providerPreset: "openaiCompat",
      coauthorTransport: "chat_completions",
      generationMode: "chat",
      endpoint: "http://localhost:9000/v1",
      apiKey: "sk-llm",
      defaultModel: "writer-default",
      contextBudget: null,
      pinContextBudget: false,
      tokenPadding: 0,
      bindPerModel: false,
      modelFreeOnly: false,
      modelGroupByOwner: false,
      maxTokens: 2048,
      temperature: 1,
      topP: 1,
      topK: 0,
      minP: 0,
      topA: 0,
      typicalP: 1,
      tfsZ: 1,
      adaptiveTarget: -1,
      adaptiveDecay: 0,
      dynatempRange: 0,
      dynatempExponent: 1,
      topNSigma: 0,
      smoothingFactor: 0,
      repeatLastN: 0,
      mirostat: 0,
      mirostatTau: 5,
      mirostatEta: 0.1,
      dryMultiplier: 0,
      dryBase: 1.75,
      dryAllowedLength: 2,
      drySequenceBreakers: [],
      dryPenaltyLastN: 0,
      bannedStrings: [],
      xtcThreshold: 0.1,
      xtcProbability: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      repetitionPenalty: 1,
      stopSequences: [],
      logitBias: [],
      seed: null,
      reasoningEffort: "auto",
      showReasoning: false,
      streamResponse: true,
      customSamplers: false,
      proxyMode: "inherit",
      proxyId: null,
      isActive: false,
      visionModel: null,
      samplerSetId: null,
      generationFormat: null,
      createdAt: "0",
      updatedAt: "0",
      ...over,
    };
  }

  /** Every quiet-call input the runner assembled, in call order. */
  interface CapturedExecuteCall {
    system: string;
    user: string;
    model: string;
    profileId: string;
    signal: AbortSignal | undefined;
  }

  interface AssistFixture {
    calls: CapturedExecuteCall[];
    deps: ImageGenAssistDeps;
    /** Reconfigure what the next execute call returns / throws. */
    setExecuteBehavior: (behavior: { text?: string; error?: Error }) => void;
  }

  function makeAssistDeps(profiles: Record<string, StoredProviderProfileRecord>): AssistFixture {
    const calls: CapturedExecuteCall[] = [];
    let behavior: { text?: string; error?: Error } = { text: "refined" };
    const deps: ImageGenAssistDeps = {
      providerProfiles: {
        getProviderProfile: async (id: string) => profiles[id] ?? null,
        getProviderModelSettings: async () => null,
      },
      execute: async (input: ProviderExecutionInput) => {
        const messages = (input.prompt.finalPayload as { messages: Array<{ role: string; content: string }> }).messages;
        calls.push({
          system: messages[0]!.content,
          user: messages[1]!.content,
          model: input.model,
          profileId: input.profile.id,
          signal: input.signal,
        });
        if (behavior.error !== undefined) throw behavior.error;
        return {
          text: behavior.text ?? "",
          providerResponse: { mode: "nonstream" as const, steps: [] },
        };
      },
    };
    return { calls, deps, setExecuteBehavior: (next) => { behavior = next; } };
  }

  /** The assist scene: character + persona + last message (the digest
   *  sources) over the prompt-capturing transport — returns the app plus a
   *  `sent` array the tests read the final wire prompt from. */
  async function makeAssistScene(
    assist: AssistFixture,
  ): Promise<{ app: ReturnType<typeof createImageGenRoutes>; chatId: string; sent: string[] }> {
    const sent: string[] = [];
    const base = await makeApp(promptCapturingTransport(sent), assist.deps);
    const char = await base.stores.characters.create({ name: "Seraphine", description: "silver-haired tavern keeper" });
    const persona = await base.stores.personas.create({ name: "Alex", description: "wandering bard" });
    const chat = await base.stores.chats.createChat({ characterId: char.id, personaId: persona.id, title: "assist", promptPresetId: null });
    await base.stores.messages.addMessage({
      chatId: chat.id,
      branchId: chat.activeBranchId as string,
      role: "user",
      authorType: "user",
      content: "The tavern door creaks open.",
    });
    return { app: base.app, chatId: chat.id, sent };
  }

  const generate = (app: ReturnType<typeof createImageGenRoutes>, chatId: string, body: Record<string, unknown>) =>
    app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  test("disabled by default: no quiet call, the wire prompt is the built template", async () => {
    const assist = makeAssistDeps({ llm1: makeLlmProfile() });
    const scene = await makeAssistScene(assist);
    const id = await seedProfile(scene.app, { apiKey: "sk-own", modelId: "or-model" });
    const res = await generate(scene.app, scene.chatId, { profileId: id, mode: "portrait" });
    expect(res.status).toBe(200);
    expect(assist.calls).toHaveLength(0);
    expect(scene.sent[0]).toContain("Seraphine");
  });

  test("toggle on + picks set: the quiet call writes the prompt; residual macros in its output still resolve", async () => {
    const assist = makeAssistDeps({ llm1: makeLlmProfile() });
    // The refinement deliberately leaves a {{char}} placeholder — the design
    // order is "the model writes the image prompt, THEN macros substitute".
    assist.setExecuteBehavior({ text: "A windswept portrait of {{char}}, rain on silver hair." });
    const scene = await makeAssistScene(assist);
    const id = await seedProfile(scene.app, {
      apiKey: "sk-own",
      modelId: "or-model",
      llmAssistEnabled: true,
      llmProviderProfileId: "llm1",
      llmModelId: "writer-model",
    });
    const res = await generate(scene.app, scene.chatId, { profileId: id, mode: "portrait" });
    expect(res.status).toBe(200);
    expect(assist.calls).toHaveLength(1);
    const call = assist.calls[0]!;
    // The quiet call rode the profile's saved LLM picks.
    expect(call.profileId).toBe("llm1");
    expect(call.model).toBe("writer-model");
    // System = the image_assist built-in instruction; user = digest + RAW
    // template (placeholders intact — the model resolves them against the
    // digest).
    expect(call.system).toContain("image-generation model");
    expect(call.user).toContain("Seraphine");
    expect(call.user).toContain("silver-haired tavern keeper");
    expect(call.user).toContain("The tavern door creaks open.");
    expect(call.user).toContain("{{char}}");
    // The refinement is the wire prompt, with its residual macro resolved.
    expect(scene.sent[0]).toContain("A windswept portrait of Seraphine, rain on silver hair.");
    expect(scene.sent[0]).not.toContain("{{");
  });

  test("toggle on but picks unset: assist inert — bit-identical legacy behavior, zero calls", async () => {
    const assist = makeAssistDeps({ llm1: makeLlmProfile() });
    const scene = await makeAssistScene(assist);
    const id = await seedProfile(scene.app, { apiKey: "sk-own", modelId: "or-model", llmAssistEnabled: true });
    const res = await generate(scene.app, scene.chatId, { profileId: id, mode: "portrait" });
    expect(res.status).toBe(200);
    expect(assist.calls).toHaveLength(0);
  });

  test("verbatim contracts exempt: free payload and chip edit never hit the quiet call", async () => {
    const assist = makeAssistDeps({ llm1: makeLlmProfile() });
    const scene = await makeAssistScene(assist);
    const id = await seedProfile(scene.app, {
      apiKey: "sk-own",
      modelId: "or-model",
      llmAssistEnabled: true,
      llmProviderProfileId: "llm1",
      llmModelId: "writer-model",
    });
    const free = await generate(scene.app, scene.chatId, { profileId: id, mode: "free", prompt: "raw caller direction" });
    expect(free.status).toBe(200);
    const chip = await generate(scene.app, scene.chatId, { profileId: id, mode: "portrait", prompt: "chip's built edit" });
    expect(chip.status).toBe(200);
    expect(assist.calls).toHaveLength(0);
    expect(scene.sent[0]).toContain("raw caller direction");
    expect(scene.sent[1]).toBe("chip's built edit");
  });

  test("quiet-call failure FAILS the generation with the normalized error (no silent fallthrough)", async () => {
    const assist = makeAssistDeps({ llm1: makeLlmProfile() });
    assist.setExecuteBehavior({
      error: new ProviderExecutionError("upstream 500: boom", "upstream", "openaiCompat", { statusCode: 500 }),
    });
    let imageTransportCalled = false;
    const base = await makeApp(
      async () => {
        imageTransportCalled = true;
        throw new TypeError("image backend must not be called");
      },
      assist.deps,
    );
    const char = await base.stores.characters.create({ name: "Seraphine", description: "silver" });
    const chat = await base.stores.chats.createChat({ characterId: char.id, personaId: null, title: "x", promptPresetId: null });
    const id = await seedProfile(base.app, {
      apiKey: "sk-own",
      modelId: "or-model",
      llmAssistEnabled: true,
      llmProviderProfileId: "llm1",
      llmModelId: "writer-model",
    });
    const res = await base.app.request(`/api/chats/${chat.id}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "portrait" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("LLM assist failed");
    expect(body.error).toContain("upstream 500: boom");
    expect(imageTransportCalled).toBe(false);
  });

  test("empty assist output → 400 (honest failure, not an empty image prompt)", async () => {
    const assist = makeAssistDeps({ llm1: makeLlmProfile() });
    assist.setExecuteBehavior({ text: "   " });
    const scene = await makeAssistScene(assist);
    const id = await seedProfile(scene.app, {
      apiKey: "sk-own",
      modelId: "or-model",
      llmAssistEnabled: true,
      llmProviderProfileId: "llm1",
      llmModelId: "writer-model",
    });
    const res = await generate(scene.app, scene.chatId, { profileId: id, mode: "portrait" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("empty");
  });

  test("dangling LLM profile id → 404; keyless key-required provider → 400", async () => {
    const assist = makeAssistDeps({ llm1: makeLlmProfile() });
    const scene = await makeAssistScene(assist);
    const dangling = await seedProfile(scene.app, {
      apiKey: "sk-own",
      modelId: "or-model",
      llmAssistEnabled: true,
      llmProviderProfileId: "gone",
      llmModelId: "writer-model",
    });
    const gone = await generate(scene.app, scene.chatId, { profileId: dangling, mode: "portrait" });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { error: string }).error).toContain("LLM provider profile");

    const keyless = makeAssistDeps({ llm1: makeLlmProfile({ apiKey: "" }) });
    const scene2 = await makeAssistScene(keyless);
    const id2 = await seedProfile(scene2.app, {
      apiKey: "sk-own",
      modelId: "or-model",
      llmAssistEnabled: true,
      llmProviderProfileId: "llm1",
      llmModelId: "writer-model",
    });
    const noKey = await generate(scene2.app, scene2.chatId, { profileId: id2, mode: "portrait" });
    expect(noKey.status).toBe(400);
    expect(((await noKey.json()) as { error: string }).error).toContain("API key");
  });

  test("the route's abort signal threads into the quiet call", async () => {
    const assist = makeAssistDeps({ llm1: makeLlmProfile() });
    const scene = await makeAssistScene(assist);
    const id = await seedProfile(scene.app, {
      apiKey: "sk-own",
      modelId: "or-model",
      llmAssistEnabled: true,
      llmProviderProfileId: "llm1",
      llmModelId: "writer-model",
    });
    const controller = new AbortController();
    const res = await scene.app.request(`/api/chats/${scene.chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "portrait" }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(assist.calls).toHaveLength(1);
    expect(assist.calls[0]!.signal).toBe(controller.signal);
  });
});

describe("image-gen routes — regenerate-as-variant (IG-18a)", () => {
  /** Two-image transport: each completions call returns a DIFFERENT image so
   *  the variant's attachment is distinguishable from the slot's first. */
  function twoImageTransport(captured: { calls: number }) {
    return mock(async (input: FetchArgs[0], _init?: FetchArgs[1]) => {
      captured.calls += 1;
      const n = captured.calls;
      if (String(input).endsWith("/chat/completions")) {
        return new Response(
          JSON.stringify({
            choices: [
              { message: { role: "assistant", images: [{ image_url: { url: `data:image/png;base64,${PNG_B64(0x10 + n)}` } }] } },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(PNG_BYTES(0x10 + n), { status: 200, headers: { "Content-Type": "image/png" } });
    });
  }

  test("targetMessageId lands the result as a VARIANT of the slot (not a sibling); selected variant carries the new attachments", async () => {
    const captured = { calls: 0 };
    const { app, stores } = await makeApp(twoImageTransport(captured));
    const chatId = await makeChat(stores);
    const id = await seedProfile(app, { apiKey: "sk-own", modelId: "gpt-image-2" });

    // First generation: the sibling-append slot (IG-14 behavior, unchanged).
    const first = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "portrait", prompt: "first image" }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { messageId: string; attachments: Array<{ assetId: string }> };

    // Regenerate onto that slot.
    const res = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: id, mode: "portrait", prompt: "second image",
        anchorMessageId: firstBody.messageId, targetMessageId: firstBody.messageId,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messageId: string; attachments: Array<{ assetId: string }> };

    // The response points at the SAME slot (variant append, not a sibling).
    expect(body.messageId).toBe(firstBody.messageId);
    expect(body.attachments[0]!.assetId).not.toBe(firstBody.attachments[0]!.assetId);

    // Variant mechanics: two variants on the slot, the new one selected,
    // carrying ITS attachments; the slot's message row keeps the FIRST set
    // (legacy projection fallback) — the DTO merge resolves per selection.
    const variants = await stores.messages.getVariants(firstBody.messageId);
    expect(variants).toHaveLength(2);
    const selected = variants.find((v) => v.isSelected);
    expect(selected?.attachmentsJson).not.toBeNull();
    const selectedAttachments = JSON.parse(selected!.attachmentsJson!) as Array<{ assetId: string; imageGen?: { mode: string; prompt?: string } }>;
    expect(selectedAttachments).toHaveLength(1);
    expect(selectedAttachments[0]!.assetId).toBe(body.attachments[0]!.assetId);
    expect(selectedAttachments[0]!.imageGen?.mode).toBe("portrait");
    // IG-CF6: the regenerate-as-variant path stamps its prompt too — the
    // chip-edit prompt rides verbatim (the IG-14 contract: a caller prompt
    // is finished text, never re-substituted).
    expect(selectedAttachments[0]!.imageGen?.prompt).toBe("second image");
    expect(variants[0]!.attachmentsJson).toBeNull();
    const slot = await stores.messages.getMessageById(firstBody.messageId);
    const slotAttachments = JSON.parse(slot!.attachmentsJson ?? "[]") as Array<{ assetId: string; imageGen?: { prompt?: string } }>;
    expect(slotAttachments[0]!.assetId).toBe(firstBody.attachments[0]!.assetId);
    expect(slotAttachments[0]!.imageGen?.prompt).toBe("first image");

    // One completions + one download per generation — nothing extra.
    expect(captured.calls).toBe(4);
  });

  test("targetMessageId pointing at a non-slot message → 400 (variant-append only onto image-gen slots)", async () => {
    const { app, stores } = await makeApp(async () => {
      throw new TypeError("must not be called");
    });
    const chatId = await makeChat(stores);
    const plain = await stores.messages.addMessage({
      chatId,
      branchId: (await stores.chats.getById(chatId))!.activeBranchId as string,
      role: "user",
      authorType: "user",
      content: "just text",
    });
    const id = await seedProfile(app, { apiKey: "sk-own", modelId: "gpt-image-2" });

    const res = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "portrait", prompt: "p", targetMessageId: plain.id }),
    });
    expect(res.status).toBe(400);
  });

  test("targetMessageId from another chat → 400", async () => {
    const { app, stores } = await makeApp(async () => {
      throw new TypeError("must not be called");
    });
    const chatId = await makeChat(stores);
    const otherChatId = await makeChat(stores);
    // A real image-gen slot — but of ANOTHER chat.
    const otherSlot = await stores.messages.addMessage({
      chatId: otherChatId,
      branchId: (await stores.chats.getById(otherChatId))!.activeBranchId as string,
      role: "assistant",
      authorType: "assistant",
      content: "",
      attachmentsJson: JSON.stringify([
        { id: "a", assetId: "s", type: "image", name: "i", mimeType: "image/png", sizeBytes: 1, imageGen: { mode: "portrait", profileId: "p" } },
      ]),
    });
    const id = await seedProfile(app, { apiKey: "sk-own", modelId: "gpt-image-2" });

    const res = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: id, mode: "portrait", prompt: "p", targetMessageId: otherSlot.id }),
    });
    expect(res.status).toBe(400);
  });
});
