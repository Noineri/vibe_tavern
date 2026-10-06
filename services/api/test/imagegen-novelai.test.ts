/**
 * NovelAI image backend wire tests (NOVELAI_PROVIDER_PLAN NAI-5a) + the
 * NAI-6a quality-toggle seam.
 *
 * T1 transport doubles through the config fetch seam; no test contacts
 * novelai.net. The generated body is the stable boundary under test.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_GEN_BACKENDS, IMAGE_GEN_BACKEND_CAPABILITIES } from "@vibe-tavern/domain";
import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";

import "../src/domain/imagegen/backends/novelai.js";
import { createImageGenBackend } from "../src/domain/imagegen/imagegen-registry.js";
import { ImageGenAdapter } from "../src/api/adapters/image-gen-adapter.js";
import { ImagePromptProfileAdapter } from "../src/api/adapters/image-prompt-profile-adapter.js";
import { createImageGenRoutes } from "../src/api/routes/image-gen.js";
import { createImagePromptProfileRoutes } from "../src/api/routes/image-prompt-profiles.js";
import { AssetService } from "../src/domain/asset/asset-service.js";
import { domainErrorToJson, httpStatusForDomainError, isDomainError } from "../src/shared/errors.js";
import { DomainError } from "../src/shared/errors.js";

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function makeTransport(respond: (url: string, init?: RequestInit) => Response): {
  transport: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const transport: typeof fetch = (url, init) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(respond(String(url), init));
  };
  return { transport, calls };
}

function sentJson(call: RecordedCall): Record<string, unknown> {
  const body = call.init?.body;
  if (typeof body !== "string") throw new Error("expected a JSON string body");
  return JSON.parse(body) as Record<string, unknown>;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function make(transport: typeof fetch) {
  return createImageGenBackend(IMAGE_GEN_BACKENDS.NovelAi, {
    endpoint: "https://image.novelai.net",
    apiKey: "pst-test",
    fetch: transport,
  });
}

function generatedImage(seed = 42): unknown {
  return { images: [{ image: PNG_BYTES.toString("base64"), index: 0, seed }] };
}

describe("NovelAI image backend (V3/V4/V5 native JSON wire)", () => {
  it("sends the V5 body with forced karras, V4 prompt fields, and inline-base64 decode", async () => {
    const t = makeTransport(() => jsonResponse(generatedImage(71), 201));
    const result = await make(t.transport).generate({
      prompt: "a lantern-lit library",
      negativePrompt: "blurry",
      model: "nai-diffusion-5-curated",
      width: 1024,
      height: 768,
      steps: 31,
      cfgScale: 8,
      cfgRescale: 0.4,
      sampler: "k_euler",
      scheduler: "native",
      seed: 99,
    });

    expect(t.calls).toHaveLength(1);
    const call = t.calls[0]!;
    expect(call.url).toBe("https://image.novelai.net/ai/generate-image");
    expect(call.init?.method).toBe("POST");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer pst-test");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Accept")).toBe("application/json");
    expect(sentJson(call)).toEqual({
      action: "generate",
      input: "a lantern-lit library",
      model: "nai-diffusion-5-curated",
      parameters: {
        params_version: 4,
        width: 1024,
        height: 768,
        steps: 31,
        scale: 8,
        cfg_rescale: 0.4,
        sampler: "k_euler",
        noise_schedule: "karras",
        seed: 99,
        n_samples: 1,
        negative_prompt: "blurry",
        ucPreset: 0,
        qualityToggle: false,
        prefer_brownian: true,
        dynamic_thresholding: false,
        legacy: false,
        legacy_v3_extend: false,
        add_original_image: false,
        controlnet_strength: 1,
        deliberate_euler_ancestral_bug: false,
        skip_cfg_above_sigma: null,
        use_coords: false,
        characterPrompts: [],
        reference_image_multiple: [],
        reference_information_extracted_multiple: [],
        reference_strength_multiple: [],
        v4_prompt: {
          caption: { base_caption: "a lantern-lit library", char_captions: [] },
          use_coords: false,
          use_order: true,
        },
        v4_negative_prompt: { caption: { base_caption: "blurry", char_captions: [] } },
      },
    });
    expect(result.images[0]?.data.equals(PNG_BYTES)).toBe(true);
    expect(result.images[0]?.mimeType).toBe("image/png");
    expect(result.seed).toBe(71);
  });

  it("normalizes V4.5 ddim to k_euler_ancestral while retaining the requested scheduler", async () => {
    const t = makeTransport(() => jsonResponse(generatedImage(), 201));
    await make(t.transport).generate({
      prompt: "p",
      model: "nai-diffusion-4-5-full",
      sampler: "ddim",
      scheduler: "native",
      seed: 7,
    });

    const parameters = sentJson(t.calls[0]!).parameters as Record<string, unknown>;
    expect(parameters.sampler).toBe("k_euler_ancestral");
    expect(parameters.noise_schedule).toBe("native");
    expect(parameters.v4_prompt).toEqual({
      caption: { base_caption: "p", char_captions: [] },
      use_coords: false,
      use_order: true,
    });
    expect(parameters.v4_negative_prompt).toEqual({ caption: { base_caption: "", char_captions: [] } });
    expect(parameters.skip_cfg_above_sigma).toBeNull();
    expect("sm" in parameters).toBe(false);
    expect("sm_dyn" in parameters).toBe(false);
  });

  it("sends V3 defaults without V4 fields and never gives skip_cfg_above_sigma a non-null value", async () => {
    const t = makeTransport(() => jsonResponse(generatedImage(), 201));
    await make(t.transport).generate({
      prompt: "p",
      model: "nai-diffusion-3",
      sampler: "ddim",
      scheduler: "exponential",
      seed: 8,
    });

    const parameters = sentJson(t.calls[0]!).parameters as Record<string, unknown>;
    expect(parameters.width).toBe(832);
    expect(parameters.height).toBe(1216);
    expect(parameters.steps).toBe(23);
    expect(parameters.scale).toBe(5);
    expect(parameters.sampler).toBe("ddim");
    expect(parameters.noise_schedule).toBe("exponential");
    expect(parameters.skip_cfg_above_sigma).toBeNull();
    expect("v4_prompt" in parameters).toBe(false);
    expect("v4_negative_prompt" in parameters).toBe(false);
  });

  it("returns the static eight-model catalog plus documented sampler and scheduler lists", async () => {
    const backend = make(makeTransport(() => jsonResponse({})).transport);
    expect((await backend.listModels()).map((model) => model.id)).toEqual([
      "nai-diffusion-5-curated",
      "nai-diffusion-5-full",
      "nai-diffusion-4-5-curated",
      "nai-diffusion-4-5-full",
      "nai-diffusion-4-curated-preview",
      "nai-diffusion-4-full",
      "nai-diffusion-3",
      "nai-diffusion-furry-3",
    ]);
    expect((await backend.listSamplers?.())?.map((sampler) => sampler.name)).toEqual([
      "k_euler_ancestral",
      "k_euler",
      "k_dpmpp_2m",
      "k_dpmpp_2m_sde",
      "k_dpmpp_sde",
      "k_dpmpp_2s_ancestral",
      "k_dpm_fast",
      "ddim",
    ]);
    expect((await backend.listSchedulers?.())?.map((scheduler) => scheduler.name)).toEqual([
      "karras",
      "native",
      "exponential",
      "polyexponential",
    ]);
  });

  it("probes the subscription endpoint: 200 accepted and 401 rejected", async () => {
    const accepted = makeTransport(() => jsonResponse({ active: true }));
    expect(await make(accepted.transport).probe()).toEqual({ ok: true, detail: "credentials accepted" });
    expect(accepted.calls[0]?.url).toBe("https://image.novelai.net/user/subscription");
    expect(new Headers(accepted.calls[0]?.init?.headers).get("Authorization")).toBe("Bearer pst-test");

    const rejected = makeTransport(() => new Response("Unauthorized", { status: 401 }));
    const result = await make(rejected.transport).probe();
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.detail).toContain("credentials rejected");
  });

  it("maps 403 and 400 recaptcha generation rejections to the active-subscription provider error", async () => {
    for (const response of [
      new Response(JSON.stringify({ message: "Model not allowed for user tier" }), { status: 403 }),
      new Response(JSON.stringify({ message: "Recaptcha token is required for trial generations" }), { status: 400 }),
    ]) {
      const t = makeTransport(() => response.clone());
      let caught: unknown;
      try {
        await make(t.transport).generate({ prompt: "p", seed: 1 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as Error).message).toContain("NovelAI image generation needs an active subscription");
    }
  });

  it("declares the contracted cloud capability surface", () => {
    const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.NovelAi];
    expect(caps).toMatchObject({
      supportsNegativePrompt: true,
      supportsSamplers: true,
      supportsSeed: true,
      supportsSteps: true,
      supportsCfgScale: true,
      sizeSupport: { kind: "free" },
      noApiKey: false,
      supportsLiveProgress: false,
      localExecution: false,
      supportsImg2img: false,
      supportsInpaint: false,
      paramRanges: {},
      defaultPromptFamily: "novelai",
    });
  });
});

describe("NovelAI qualityToggle on the wire (NAI-6a)", () => {
  it("sends qualityToggle true when the vendor block carries it", async () => {
    const t = makeTransport(() => jsonResponse(generatedImage(), 201));
    await make(t.transport).generate({
      prompt: "p",
      model: "nai-diffusion-5-full",
      seed: 3,
      novelai: { qualityToggle: true },
    });
    expect((sentJson(t.calls[0]!).parameters as Record<string, unknown>).qualityToggle).toBe(true);
  });

  it("keeps qualityToggle false for an explicit false and an absent block", async () => {
    const explicit = makeTransport(() => jsonResponse(generatedImage(), 201));
    await make(explicit.transport).generate({ prompt: "p", seed: 3, novelai: { qualityToggle: false } });
    expect((sentJson(explicit.calls[0]!).parameters as Record<string, unknown>).qualityToggle).toBe(false);

    const absent = makeTransport(() => jsonResponse(generatedImage(), 201));
    await make(absent.transport).generate({ prompt: "p", seed: 3 });
    expect((sentJson(absent.calls[0]!).parameters as Record<string, unknown>).qualityToggle).toBe(false);
  });
});

/** Full-stack fixture (the imagegen-routes pattern): disk DB + real
 *  adapter + real routes; the ONLY double is the transport through the
 *  adapter's fetchOverride seam (tier T1). */
async function makeApp(transport: typeof fetch): Promise<{
  app: ReturnType<typeof createImageGenRoutes>;
  promptProfiles: ReturnType<typeof createImagePromptProfileRoutes>;
  stores: StoreContainer;
}> {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-imagegen-novelai-"));
  const assetsDir = join(dataRoot, "assets");
  await mkdir(assetsDir, { recursive: true });
  const stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  const assetService = new AssetService(assetsDir, stores.content);
  const adapter = new ImageGenAdapter(stores, assetService, transport);
  const app = createImageGenRoutes(adapter);
  app.onError((err, c) => {
    if (isDomainError(err)) {
      return c.json(domainErrorToJson(err), httpStatusForDomainError(err) as 400 | 404 | 409 | 422 | 500);
    }
    return c.json({ error: { kind: "Internal", message: err instanceof Error ? err.message : "error" } }, 500);
  });
  const promptProfiles = createImagePromptProfileRoutes(new ImagePromptProfileAdapter({ db: stores.db }));
  return { app, promptProfiles, stores };
}

describe("NovelAI qualityToggle through the generate route (NAI-6a)", () => {
  // The vendor block is `qualityLayerEnabled && resolved family ===
  // "novelai"` — true ONLY with the backend-default novelai family AND the
  // profile's quality-layer switch on. The novelai canon assets do not
  // exist yet (NAI-6c/6d), so the ACTIVE image-prompt profile carries
  // custom cells for the two rows the build resolves (the chain's real
  // tier 1 — no mocks; the family/default resolution under test is the
  // real resolver's).

  const jsonHeaders = { "Content-Type": "application/json" };

  async function setup() {
    const bodies: Record<string, unknown>[] = [];
    const transport: typeof fetch = (url, init) => {
      if (String(url).endsWith("/ai/generate-image")) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Promise.resolve(jsonResponse(generatedImage(), 201));
      }
      return Promise.resolve(jsonResponse({}, 200));
    };
    const { app, promptProfiles, stores } = await makeApp(transport);
    const character = await stores.characters.create({ name: "Test" });
    const chatId = (
      await stores.chats.createChat({ characterId: character.id, title: "t", promptPresetId: null })
    ).id;
    // Custom cells for the two rows the portrait build resolves under the
    // novelai family (its canon assets ship in NAI-6c/6d).
    const profile = await promptProfiles.request("/api/image-gen/prompt-profiles", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "NovelAI cells",
        overrides: {
          "portrait|novelai": { body: "NOVELAI-PORTRAIT {{char}}" },
          "negative|novelai": { body: "NOVELAI-NEG" },
        },
      }),
    });
    expect(profile.status).toBe(201);
    const { id: promptProfileId } = (await profile.json()) as { id: string };
    const active = await promptProfiles.request("/api/image-gen/prompt-profiles/active", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ profileId: promptProfileId }),
    });
    expect(active.status).toBe(200);
    return { app, bodies, chatId };
  }

  async function createImageGenProfile(app: ReturnType<typeof createImageGenRoutes>, qualityLayerEnabled: boolean) {
    const res = await app.request("/api/image-gen/profiles", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "NovelAI",
        backend: IMAGE_GEN_BACKENDS.NovelAi,
        endpoint: "https://image.novelai.net",
        apiKey: "pst-test",
        modelId: "nai-diffusion-5-curated",
        qualityLayerEnabled,
        defaultParams: {},
        modeSizePresets: {},
        capabilities: IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.NovelAi],
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  const run = async (app: ReturnType<typeof createImageGenRoutes>, chatId: string, profileId: string) => {
    const res = await app.request(`/api/chats/${chatId}/image-gen/generate`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ profileId, mode: "portrait", prompt: "a" }),
    });
    expect(res.status).toBe(200);
  };

  it("true with the backend-default novelai family and the layer on; false with the layer off", async () => {
    const { app, bodies, chatId } = await setup();
    const id = await createImageGenProfile(app, true);
    await run(app, chatId, id);
    expect(((bodies[0]!.parameters as Record<string, unknown>).qualityToggle)).toBe(true);

    const patch = await app.request(`/api/image-gen/profiles/${id}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ qualityLayerEnabled: false }),
    });
    expect(patch.status).toBe(200);
    await run(app, chatId, id);
    expect(((bodies[1]!.parameters as Record<string, unknown>).qualityToggle)).toBe(false);
  });

  it("false when the family is pinned away from novelai (pin beats the backend default)", async () => {
    const { app, bodies, chatId } = await setup();
    const id = await createImageGenProfile(app, true);
    const pin = await app.request(`/api/image-gen/profiles/${id}/family`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ family: "prose" }),
    });
    expect(pin.status).toBe(200);
    await run(app, chatId, id);
    expect(((bodies[0]!.parameters as Record<string, unknown>).qualityToggle)).toBe(false);
  });
});
