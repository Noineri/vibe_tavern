/**
 * Unit tests for the PE-1 OpenAI-images transport family
 * (IMAGEGEN_PROVIDER_EXPANSION_PLAN wave PE-1 —
 * backends/openai-images-family.ts): one describe block per provider, each
 * pinning its card's wire shape (request URL/method/auth/body, response
 * envelope, model-list path + filter, probe) plus the capability-table row
 * and the registry registration. Every pinned shape traces to the
 * provider's card in IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH (doc-verified
 * 2026-09-07) with the supervisor's 2026-09-18 live re-verification deltas
 * applied where the card drifted.
 *
 * Doubles: mocked transport at the config-injected fetch seam (tier T1 —
 * the double is a function argument, no mock.module, no globalThis patches,
 * no registry resets: the family modules register at import time and this
 * file relies on those registrations).
 */

import { describe, expect, it } from "bun:test";
import { IMAGE_GEN_BACKENDS, IMAGE_GEN_BACKEND_CAPABILITIES } from "@vibe-tavern/domain";

// Importing the family module registers every PE-1 slug (import-time
// registration — what these tests pin).
import "../src/domain/imagegen/backends/openai-images-family.js";
import { SILICONFLOW_IMAGE_SIZES, ELECTRONHUB_IMAGE_SIZES } from "../src/domain/imagegen/backends/openai-images-family.js";
import { createImageGenBackend } from "../src/domain/imagegen/imagegen-registry.js";
import { OpenAiImagesConfigError, OpenAiImagesError } from "../src/domain/imagegen/backends/openai-images.js";
import type { ImageGenBackend } from "../src/domain/imagegen/imagegen-registry.js";

/** Known 8-byte PNG-magic payload (sniffable as image/png). */
const PNG_BYTES = Buffer.from("iVBORw0KGgo=", "base64");

/** An images-generations response carrying `data[].b64_json`. */
function b64DataResponse(buffers: Buffer[]): Response {
  return Response.json({
    created: 0,
    data: buffers.map((buffer) => ({ b64_json: buffer.toString("base64") })),
  });
}

/** Build the injected fetch double. Records every call; dispatches by URL:
 *  the generations POST / models GET go to `handler`, data: URLs decode
 *  through the real fetch (pins the native data-URL download path), and an
 *  already-aborted signal rejects like a real transport. */
interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function makeTransport(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const transport = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    if (init?.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const url = String(input);
    if (url.startsWith("data:")) {
      // The real transport resolves data: URLs natively — keep that real so
      // the test pins actual byte decoding, not a re-implementation.
      return fetch(url, init);
    }
    return handler(new URL(url), init);
  };
  return { transport, calls };
}

/** Parse the recorded JSON body of a POST. */
function sentJson(call: RecordedCall): Record<string, unknown> {
  expect(call.init?.method).toBe("POST");
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

/** Create the provider's backend through the REGISTRY (pins the
 *  import-time registration of the slug, not just the factory). */
function familyBackend(slug: string, transport: typeof fetch, endpoint: string, apiKey = "key"): ImageGenBackend {
  return createImageGenBackend(slug, { endpoint, apiKey, fetch: transport });
}

// ─── SiliconFlow (PE-1 unit 2) ────────────────────────────────────────────────

const SILICONFLOW_ENDPOINT = "https://api.siliconflow.com/v1";

describe("siliconflow (openai-images family)", () => {
  const make = (transport: typeof fetch) =>
    familyBackend(IMAGE_GEN_BACKENDS.SiliconFlow, transport, SILICONFLOW_ENDPOINT, "sf-key");

  describe("generate", () => {
    it("sends the card's own schema: image_size string param, NEVER response_format", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({ images: [{ url: "https://sc.provider/img.png" }], timings: {}, seed: 7 }),
      );
      const backend = make(transport);

      await backend.generate({
        prompt: "a tavern at dusk",
        model: "black-forest-labs/FLUX.2-pro",
        width: 1024,
        height: 1024,
      });

      expect(calls[0].url).toBe(`${SILICONFLOW_ENDPOINT}/images/generations`);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sf-key");
      const body = sentJson(calls[0]);
      expect(body.model).toBe("black-forest-labs/FLUX.2-pro");
      expect(body.image_size).toBe("1024x1024");
      expect("size" in body).toBe(false);
      // `response_format` is not documented for this endpoint — never sent.
      expect("response_format" in body).toBe(false);
    });

    it("maps steps/cfgScale/seed/negativePrompt onto the card's wire names only when set", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({ images: [{ url: "https://sc.provider/img.png" }], seed: 1 }),
      );
      const backend = make(transport);
      await backend.generate({
        prompt: "p",
        model: "Qwen/Qwen-Image",
        width: 1328,
        height: 1328,
        steps: 30,
        cfgScale: 4,
        seed: 9999999999,
        negativePrompt: "watermark",
      });
      const body = sentJson(calls[0]);
      expect(body.num_inference_steps).toBe(30);
      expect(body.guidance_scale).toBe(4);
      expect(body.seed).toBe(9999999999);
      expect(body.negative_prompt).toBe("watermark");

      const bare = makeTransport(() =>
        Response.json({ images: [{ url: "https://sc.provider/img.png" }], seed: 1 }),
      );
      await make(bare.transport).generate({ prompt: "p", model: "Qwen/Qwen-Image" });
      const bareBody = sentJson(bare.calls[0]);
      for (const key of ["num_inference_steps", "guidance_scale", "seed", "negative_prompt"]) {
        expect(key in bareBody).toBe(false);
      }
    });

    it("fails closed on an off-grid size; user entries ride verbatim (IG-20a)", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({ images: [{ url: "https://sc.provider/img.png" }] }),
      );
      const backend = make(transport);
      await expect(
        backend.generate({ prompt: "p", model: "Qwen/Qwen-Image", width: 999, height: 999 }),
      ).rejects.toThrow(/SiliconFlow has no documented size for 999x999/);
      expect(calls).toHaveLength(0);

      const user = makeTransport(() =>
        Response.json({ images: [{ url: "https://sc.provider/img.png" }] }),
      );
      const userBackend = createImageGenBackend(IMAGE_GEN_BACKENDS.SiliconFlow, {
        endpoint: SILICONFLOW_ENDPOINT,
        apiKey: "sf-key",
        userSizes: [{ width: 1664, height: 1664 }],
        fetch: user.transport,
      });
      await userBackend.generate({ prompt: "p", model: "Qwen/Qwen-Image", width: 1664, height: 1664 });
      expect(sentJson(user.calls[0]).image_size).toBe("1664x1664");
    });

    it("normalizes the images[].url envelope and reports the effective seed (URL is 1h-limited → server-side download)", async () => {
      const imageUrl = "https://sc.provider/img.png";
      const { transport, calls } = makeTransport((url) =>
        url.href === imageUrl
          ? new Response(PNG_BYTES, { headers: { "content-type": "image/png" } })
          : Response.json({ images: [{ url: imageUrl }], timings: { inference: 1.5 }, seed: 1234567 }),
      );
      const backend = make(transport);
      const result = await backend.generate({ prompt: "p", model: "Tongyi-MAI/Z-Image-Turbo" });
      // Two seam calls: the generations POST, then the server-side download.
      expect(calls.map((call) => call.url)).toEqual([
        `${SILICONFLOW_ENDPOINT}/images/generations`,
        imageUrl,
      ]);
      expect(result.images[0].data.equals(PNG_BYTES)).toBe(true);
      expect(result.images[0].mimeType).toBe("image/png");
      // The envelope's effective seed rides onto the result.
      expect(result.seed).toBe(1234567);
    });

    it("rejects a response without the images[] array", async () => {
      const { transport } = makeTransport(() => Response.json({ data: [{ b64_json: "x" }] }));
      const backend = make(transport);
      await expect(backend.generate({ prompt: "p", model: "Qwen/Qwen-Image" })).rejects.toBeInstanceOf(
        OpenAiImagesError,
      );
    });
  });

  describe("listModels + probe", () => {
    it("queries GET /models with Bearer and lists the catalog UNFILTERED; probe counts the same", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({ data: [{ id: "Qwen/Qwen-Image" }, { id: "deepseek-ai/DeepSeek-V3" }] }),
      );
      const backend = make(transport);
      const models = await backend.listModels();
      expect(models.map((m) => m.id)).toEqual(["Qwen/Qwen-Image", "deepseek-ai/DeepSeek-V3"]);
      expect(calls[0].url).toBe(`${SILICONFLOW_ENDPOINT}/models`);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sf-key");

      const probed = await backend.probe();
      expect(probed).toEqual({ ok: true, detail: "2 models" });
    });
  });

  describe("capability row + registry", () => {
    it("pins the SiliconFlow capability row (vendor-set union grid + card param ranges)", () => {
      const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.SiliconFlow];
      expect(caps.supportsNegativePrompt).toBe(true); // Qwen/Z-Image/Ultra only — caveat in the row comment
      expect(caps.supportsSamplers).toBe(false);
      expect(caps.supportsSeed).toBe(true);
      expect(caps.noApiKey).toBe(false);
      expect(caps.localExecution).toBe(false);
      expect(caps.paramRanges).toEqual({
        steps: { min: 1, max: 100, step: 1 },
        cfgScale: { min: 0, max: 20, step: 0.5 },
      });
      if (caps.sizeSupport.kind !== "vendor-set") throw new Error("expected vendor-set");
      // Lockstep: the capability grid IS the adapter's documented union grid.
      expect(caps.sizeSupport.sizes).toEqual([...SILICONFLOW_IMAGE_SIZES.keys()]);
    });

    it("registers the siliconflow slug at import time (creatable via the registry)", () => {
      const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.SiliconFlow, {
        endpoint: SILICONFLOW_ENDPOINT,
        apiKey: "sf-key",
      });
      expect(typeof backend.generate).toBe("function");
      expect(typeof backend.listModels).toBe("function");
    });
  });
});

// ─── NanoGPT (PE-1 unit 3) ─────────────────────────────────────────────────

const NANOGPT_ENDPOINT = "https://nano-gpt.com/api/v1";

describe("nanogpt (openai-images family)", () => {
  const make = (transport: typeof fetch) =>
    familyBackend(IMAGE_GEN_BACKENDS.NanoGpt, transport, NANOGPT_ENDPOINT, "ng-key");

  describe("generate", () => {
    it("sends the OpenAI-images body: size string VERBATIM + response_format b64_json", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);

      const result = await backend.generate({
        prompt: "a tavern at dusk",
        model: "nano-banana-2",
        width: 1280,
        height: 720,
      });

      expect(calls[0].url).toBe(`${NANOGPT_ENDPOINT}/images/generations`);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ng-key");
      const body = sentJson(calls[0]);
      expect(body.model).toBe("nano-banana-2");
      expect(body.prompt).toBe("a tavern at dusk");
      expect(body.size).toBe("1280x720");
      // Documented param; URL lifetime unstated → bytes preferred.
      expect(body.response_format).toBe("b64_json");
      expect(result.images[0].data.equals(PNG_BYTES)).toBe(true);
      expect(result.width).toBe(1280);
      expect(result.height).toBe(720);
    });

    it("omits size when no COMPLETE size is set (no documented grid — no fail-closed error)", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);
      await backend.generate({ prompt: "p", model: "nano-banana-2", width: 1024 });
      expect("size" in sentJson(calls[0])).toBe(false);
    });

    it("never sends negative prompt / steps / seed (no card surface)", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);
      await backend.generate({
        prompt: "p",
        model: "nano-banana-2",
        steps: 20,
        cfgScale: 5,
        seed: 7,
        negativePrompt: "blurry",
      });
      const body = sentJson(calls[0]);
      expect("negative_prompt" in body).toBe(false);
      expect("steps" in body).toBe(false);
      expect("guidance_scale" in body).toBe(false);
      expect("seed" in body).toBe(false);
    });
  });

  describe("listModels + probe", () => {
    it("queries the DIFFERENT image-models path (public no-auth) with the Bearer key sent anyway", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({
          data: [
            { id: "nano-banana-2", description: "Gemini image" },
            { id: "seedream-v4.5" },
          ],
        }),
      );
      const backend = make(transport);
      const models = await backend.listModels();
      expect(models).toEqual([
        { id: "nano-banana-2", label: "nano-banana-2", description: "Gemini image" },
        { id: "seedream-v4.5", label: "seedream-v4.5" },
      ]);
      expect(calls[0].url).toBe(`${NANOGPT_ENDPOINT}/image-models`);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ng-key");

      const probed = await backend.probe();
      expect(probed).toEqual({ ok: true, detail: "2 image models" });
    });
  });

  describe("capability row + registry", () => {
    it("pins the NanoGPT capability row (all-off flags, free sizes)", () => {
      const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.NanoGpt];
      expect(caps.supportsNegativePrompt).toBe(false);
      expect(caps.supportsSamplers).toBe(false);
      expect(caps.supportsSeed).toBe(false);
      expect(caps.sizeSupport).toEqual({ kind: "free" });
      expect(caps.noApiKey).toBe(false);
      expect(caps.localExecution).toBe(false);
      expect(caps.paramRanges).toEqual({});
    });

    it("registers the nanogpt slug at import time (creatable via the registry)", () => {
      const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.NanoGpt, {
        endpoint: NANOGPT_ENDPOINT,
        apiKey: "ng-key",
      });
      expect(typeof backend.generate).toBe("function");
      expect(typeof backend.listModels).toBe("function");
    });
  });
});

// ─── ElectronHub (PE-1 unit 4) ─────────────────────────────────────────────

const ELECTRONHUB_ENDPOINT = "https://api.electronhub.ai/v1";

describe("electronhub (openai-images family)", () => {
  const make = (transport: typeof fetch) =>
    familyBackend(IMAGE_GEN_BACKENDS.ElectronHub, transport, ELECTRONHUB_ENDPOINT, "ek-key");

  describe("generate", () => {
    it("sends the documented OpenAI-images body: size from the DALL-E-shaped grid + response_format b64_json", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);

      await backend.generate({
        prompt: "a tavern at dusk",
        model: "stable-diffusion-3.5-large",
        width: 1792,
        height: 1024,
      });

      expect(calls[0].url).toBe(`${ELECTRONHUB_ENDPOINT}/images/generations`);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ek-key");
      const body = sentJson(calls[0]);
      expect(body.model).toBe("stable-diffusion-3.5-large");
      expect(body.size).toBe("1792x1024");
      // URL lifetime UNVERIFIED on the card → bytes requested.
      expect(body.response_format).toBe("b64_json");
    });

    it("fails closed on an off-grid size; user entries ride verbatim (IG-20a)", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);
      await expect(
        backend.generate({ prompt: "p", model: "aamxl", width: 832, height: 1216 }),
      ).rejects.toThrow(/ElectronHub has no documented size for 832x1216/);
      expect(calls).toHaveLength(0);

      const user = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const userBackend = createImageGenBackend(IMAGE_GEN_BACKENDS.ElectronHub, {
        endpoint: ELECTRONHUB_ENDPOINT,
        apiKey: "ek-key",
        userSizes: [{ width: 832, height: 1216 }],
        fetch: user.transport,
      });
      await userBackend.generate({ prompt: "p", model: "aamxl", width: 832, height: 1216 });
      expect(sentJson(user.calls[0]).size).toBe("832x1216");
    });

    it("never sends negative prompt / steps / seed (no OpenAPI surface)", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);
      await backend.generate({
        prompt: "p",
        model: "aamxl",
        steps: 25,
        cfgScale: 5,
        seed: 9,
        negativePrompt: "blurry",
      });
      const body = sentJson(calls[0]);
      expect("negative_prompt" in body).toBe(false);
      expect("steps" in body).toBe(false);
      expect("guidance_scale" in body).toBe(false);
      expect("seed" in body).toBe(false);
    });
  });

  describe("listModels + probe", () => {
    it("queries GET /models with Bearer and lists the catalog UNFILTERED (no documented discriminator)", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({
          data: [
            { id: "stable-diffusion-3.5-large" },
            { id: "aamxl" },
            { id: "gpt-4o" }, // LLM row — no discriminator documented → kept
          ],
        }),
      );
      const backend = make(transport);
      const models = await backend.listModels();
      expect(models.map((m) => m.id)).toEqual(["stable-diffusion-3.5-large", "aamxl", "gpt-4o"]);
      expect(calls[0].url).toBe(`${ELECTRONHUB_ENDPOINT}/models`);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ek-key");

      const probed = await backend.probe();
      expect(probed).toEqual({ ok: true, detail: "3 models" });
    });
  });

  describe("capability row + registry", () => {
    it("pins the ElectronHub capability row (documented five-value size grid)", () => {
      const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.ElectronHub];
      expect(caps.supportsNegativePrompt).toBe(false);
      expect(caps.supportsSamplers).toBe(false);
      expect(caps.supportsSeed).toBe(false);
      expect(caps.noApiKey).toBe(false);
      expect(caps.localExecution).toBe(false);
      expect(caps.paramRanges).toEqual({});
      if (caps.sizeSupport.kind !== "vendor-set") throw new Error("expected vendor-set");
      // Lockstep: the capability grid IS the adapter's documented grid.
      expect(caps.sizeSupport.sizes).toEqual([...ELECTRONHUB_IMAGE_SIZES.keys()]);
    });

    it("registers the electronhub slug at import time (creatable via the registry)", () => {
      const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.ElectronHub, {
        endpoint: ELECTRONHUB_ENDPOINT,
        apiKey: "ek-key",
      });
      expect(typeof backend.generate).toBe("function");
      expect(typeof backend.listModels).toBe("function");
    });
  });
});

// ─── Pollinations unified gateway (PE-1 unit 5) ───────────────────────────

const POLLINATIONS_ENDPOINT = "https://gen.pollinations.ai/v1";

describe("pollinations (openai-images family)", () => {
  const make = (transport: typeof fetch) =>
    familyBackend(IMAGE_GEN_BACKENDS.Pollinations, transport, POLLINATIONS_ENDPOINT, "pk-key");

  describe("generate", () => {
    it("sends the OpenAI-images body: free-form size string + response_format b64_json", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);

      await backend.generate({
        prompt: "a tavern at dusk",
        model: "seedream5",
        width: 1280,
        height: 720,
      });

      expect(calls[0].url).toBe(`${POLLINATIONS_ENDPOINT}/images/generations`);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer pk-key");
      const body = sentJson(calls[0]);
      expect(body.model).toBe("seedream5");
      expect(body.size).toBe("1280x720");
      expect(body.response_format).toBe("b64_json");
    });

    it("requires an API key (generation is keyed on the unified gateway)", async () => {
      expect(() =>
        createImageGenBackend(IMAGE_GEN_BACKENDS.Pollinations, {
          endpoint: POLLINATIONS_ENDPOINT,
          apiKey: "",
        }),
      ).toThrow(/apiKey.*required/);
    });

    it("never sends negative prompt / steps / seed / quality (no contract seam)", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);
      await backend.generate({
        prompt: "p",
        model: "flux-2-pro",
        steps: 30,
        cfgScale: 4,
        seed: 11,
        negativePrompt: "watermark",
      });
      const body = sentJson(calls[0]);
      expect("negative_prompt" in body).toBe(false);
      expect("steps" in body).toBe(false);
      expect("guidance_scale" in body).toBe(false);
      expect("seed" in body).toBe(false);
      expect("quality" in body).toBe(false);
    });
  });

  describe("listModels + probe", () => {
    it("filters the public catalog by the DOCUMENTED category field and reads title as the label", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({
          data: [
            {
              id: "openai/gpt-5.4-nano",
              category: "text",
              title: "GPT-5.4 Nano",
            },
            {
              id: "seedream5",
              category: "image",
              title: "Seedream 5",
              description: "ByteDance Seedream via gateway",
            },
            { id: "nanobanana-2", category: "image" },
            { id: "some-audio-model", category: "audio", title: "Audio" },
          ],
        }),
      );
      const backend = make(transport);
      const models = await backend.listModels();
      // The one family row that FILTERS: category is a documented field
      // (live-verified 2026-09-18), not a guessed id heuristic.
      expect(models).toEqual([
        { id: "seedream5", label: "Seedream 5", description: "ByteDance Seedream via gateway" },
        { id: "nanobanana-2", label: "nanobanana-2" },
      ]);
      expect(calls[0].url).toBe(`${POLLINATIONS_ENDPOINT}/models`);

      const probed = await backend.probe();
      expect(probed).toEqual({ ok: true, detail: "2 image models" });
    });
  });

  describe("capability row + registry", () => {
    it("pins the Pollinations capability row (free sizes, all-off params)", () => {
      const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.Pollinations];
      expect(caps.supportsNegativePrompt).toBe(false);
      expect(caps.supportsSamplers).toBe(false);
      expect(caps.supportsSeed).toBe(false);
      expect(caps.sizeSupport).toEqual({ kind: "free" });
      expect(caps.noApiKey).toBe(false);
      expect(caps.localExecution).toBe(false);
      expect(caps.paramRanges).toEqual({});
    });

    it("registers the pollinations slug at import time (creatable via the registry)", () => {
      const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.Pollinations, {
        endpoint: POLLINATIONS_ENDPOINT,
        apiKey: "pk-key",
      });
      expect(typeof backend.generate).toBe("function");
      expect(typeof backend.listModels).toBe("function");
    });
  });
});

// ─── DeepInfra (PE-1 unit 6) ─────────────────────────────────────────────

const DEEPINFRA_ENDPOINT = "https://api.deepinfra.com/v1";

describe("deepinfra (openai-images family)", () => {
  const make = (transport: typeof fetch) =>
    familyBackend(IMAGE_GEN_BACKENDS.DeepInfra, transport, DEEPINFRA_ENDPOINT, "di-key");

  describe("generate", () => {
    it("hits the CANONICAL path (/v1/images/generations — the 2026-09-18 drift fix) with free-form WxH + b64_json", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);

      await backend.generate({
        prompt: "a tavern at dusk",
        model: "black-forest-labs/FLUX-2-dev",
        width: 1024,
        height: 768,
      });

      // The re-verified canonical path — NOT the card's legacy
      // /v1/openai/images/generations alias.
      expect(calls[0].url).toBe(`${DEEPINFRA_ENDPOINT}/images/generations`);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer di-key");
      const body = sentJson(calls[0]);
      expect(body.model).toBe("black-forest-labs/FLUX-2-dev");
      expect(body.size).toBe("1024x768");
      expect(body.response_format).toBe("b64_json");
    });

    it("omits size when unset (the vendor's 1024x1024 default applies — never ours)", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);
      await backend.generate({ prompt: "p", model: "black-forest-labs/FLUX-2-dev" });
      expect("size" in sentJson(calls[0])).toBe(false);
    });

    it("never sends negative prompt / steps / seed / quality (no surface or seam)", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);
      await backend.generate({
        prompt: "p",
        model: "Qwen/Qwen-Image-Max",
        steps: 28,
        cfgScale: 4.5,
        seed: 3,
        negativePrompt: "text",
      });
      const body = sentJson(calls[0]);
      expect("negative_prompt" in body).toBe(false);
      expect("steps" in body).toBe(false);
      expect("guidance_scale" in body).toBe(false);
      expect("seed" in body).toBe(false);
      expect("quality" in body).toBe(false);
    });
  });

  describe("listModels + probe", () => {
    it("queries the PUBLIC GET /models (no auth wall) and lists the bare-array catalog UNFILTERED", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json([
          { id: "black-forest-labs/FLUX-2-dev", description: "FLUX.2 dev" },
          { id: "Qwen/Qwen-Image-Max" },
          { id: "deepseek-ai/DeepSeek-V3" }, // LLM row — no discriminator → kept
        ]),
      );
      const backend = make(transport);
      const models = await backend.listModels();
      expect(models).toEqual([
        { id: "black-forest-labs/FLUX-2-dev", label: "black-forest-labs/FLUX-2-dev", description: "FLUX.2 dev" },
        { id: "Qwen/Qwen-Image-Max", label: "Qwen/Qwen-Image-Max" },
        { id: "deepseek-ai/DeepSeek-V3", label: "deepseek-ai/DeepSeek-V3" },
      ]);
      expect(calls[0].url).toBe(`${DEEPINFRA_ENDPOINT}/models`);

      const probed = await backend.probe();
      expect(probed).toEqual({ ok: true, detail: "3 models" });
    });
  });

  describe("capability row + registry", () => {
    it("pins the DeepInfra capability row (free sizes, all-off params)", () => {
      const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.DeepInfra];
      expect(caps.supportsNegativePrompt).toBe(false);
      expect(caps.supportsSamplers).toBe(false);
      expect(caps.supportsSeed).toBe(false);
      expect(caps.sizeSupport).toEqual({ kind: "free" });
      expect(caps.noApiKey).toBe(false);
      expect(caps.localExecution).toBe(false);
      expect(caps.paramRanges).toEqual({});
    });

    it("registers the deepinfra slug at import time (creatable via the registry)", () => {
      const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.DeepInfra, {
        endpoint: DEEPINFRA_ENDPOINT,
        apiKey: "di-key",
      });
      expect(typeof backend.generate).toBe("function");
      expect(typeof backend.listModels).toBe("function");
    });
  });
});

// ─── Recraft (PE-1 unit 7) ─────────────────────────────────────────────

const RECRAFT_ENDPOINT = "https://external.api.recraft.ai/v1";

describe("recraft (openai-images family)", () => {
  const make = (transport: typeof fetch) =>
    familyBackend(IMAGE_GEN_BACKENDS.Recraft, transport, RECRAFT_ENDPOINT, "rc-key");

  describe("generate", () => {
    it("sends the client-compatible body: free-form WxH, b64_json, and NEVER negative_prompt", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);

      await backend.generate({
        prompt: "a tavern at dusk",
        model: "recraftv4_1",
        width: 1365,
        height: 1024,
        seed: 77,
        negativePrompt: "watermark", // set by the caller — V4/4.1 REJECTS the field → never sent
      });

      expect(calls[0].url).toBe(`${RECRAFT_ENDPOINT}/images/generations`);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer rc-key");
      const body = sentJson(calls[0]);
      expect(body.model).toBe("recraftv4_1");
      expect(body.size).toBe("1365x1024");
      expect(body.response_format).toBe("b64_json");
      // The documented V2/V3-only field: absent wire name — NEVER on the wire
      // regardless of what the caller set (V4/4.1 rejects it).
      expect("negative_prompt" in body).toBe(false);
      // Recraft's documented wire name for the seed.
      expect(body.random_seed).toBe(77);
      expect("seed" in body).toBe(false);
    });

    it("never sends steps/guidance (no surface) and omits seed when unset", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);
      await backend.generate({ prompt: "p", model: "recraftv4_1", steps: 30, cfgScale: 5 });
      const body = sentJson(calls[0]);
      expect("steps" in body).toBe(false);
      expect("guidance_scale" in body).toBe(false);
      expect("random_seed" in body).toBe(false);
      // Style family fields have no contract seam — never invented.
      expect("style" in body).toBe(false);
      expect("style_id" in body).toBe(false);
    });
  });

  describe("listModels + probe", () => {
    it("queries the LIVE-but-undocumented GET /models (existence-probed 2026-09-18) UNFILTERED", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({ data: [{ id: "recraftv4_1" }, { id: "recraftv3" }] }),
      );
      const backend = make(transport);
      const models = await backend.listModels();
      expect(models.map((m) => m.id)).toEqual(["recraftv4_1", "recraftv3"]);
      expect(calls[0].url).toBe(`${RECRAFT_ENDPOINT}/models`);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer rc-key");

      const probed = await backend.probe();
      expect(probed).toEqual({ ok: true, detail: "2 models" });
    });
  });

  describe("capability row + registry", () => {
    it("pins the Recraft capability row (seed on, negative OFF — V4/4.1 rejects it)", () => {
      const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.Recraft];
      expect(caps.supportsNegativePrompt).toBe(false);
      expect(caps.supportsSamplers).toBe(false);
      expect(caps.supportsSeed).toBe(true);
      expect(caps.sizeSupport).toEqual({ kind: "free" });
      expect(caps.noApiKey).toBe(false);
      expect(caps.localExecution).toBe(false);
      expect(caps.paramRanges).toEqual({});
    });

    it("registers the recraft slug at import time (creatable via the registry)", () => {
      const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.Recraft, {
        endpoint: RECRAFT_ENDPOINT,
        apiKey: "rc-key",
      });
      expect(typeof backend.generate).toBe("function");
      expect(typeof backend.listModels).toBe("function");
    });
  });
});

// ─── Together AI (PE-1 unit 1) ───────────────────────────────────────────────

const TOGETHER_ENDPOINT = "https://api.together.ai/v1";

describe("togetherai (openai-images family)", () => {
  const make = (transport: typeof fetch) => familyBackend(IMAGE_GEN_BACKENDS.TogetherAi, transport, TOGETHER_ENDPOINT, "tg-key");

  describe("generate", () => {
    it("sends the card's body: width/height INTEGERS + response_format base64 (NOT a size string)", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);

      const result = await backend.generate({
        prompt: "a tavern at dusk",
        model: "black-forest-labs/FLUX.1-schnell",
        width: 1024,
        height: 768,
      });

      expect(calls.map((call) => call.url)).toEqual([`${TOGETHER_ENDPOINT}/images/generations`]);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tg-key");
      expect(headers["Content-Type"]).toBe("application/json");

      const body = sentJson(calls[0]);
      expect(body.model).toBe("black-forest-labs/FLUX.1-schnell");
      expect(body.prompt).toBe("a tavern at dusk");
      // The card's param surface: width/height integers, never a size string.
      expect(body.width).toBe(1024);
      expect(body.height).toBe(768);
      expect("size" in body).toBe(false);
      // The card's response_format enum is url|base64 — base64 requests
      // inline bytes (the hosted-URL lifetime question never arises).
      expect(body.response_format).toBe("base64");

      expect(result.images).toHaveLength(1);
      expect(result.images[0].data.equals(PNG_BYTES)).toBe(true);
      expect(result.images[0].mimeType).toBe("image/png");
      expect(result.width).toBe(1024);
      expect(result.height).toBe(768);
    });

    it("maps steps/cfgScale/seed/negativePrompt onto the card's wire names — ONLY when the caller set them", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);
      await backend.generate({
        prompt: "p",
        model: "black-forest-labs/FLUX.1-schnell",
        steps: 8,
        cfgScale: 3.5,
        seed: 42,
        negativePrompt: "blurry",
      });
      const body = sentJson(calls[0]);
      expect(body.steps).toBe(8);
      expect(body.guidance_scale).toBe(3.5);
      expect(body.seed).toBe(42);
      expect(body.negative_prompt).toBe("blurry");

      // Nothing set → nothing sent (no invented defaults; the card's
      // defaults 20 / 3.5 are the vendor's, never ours).
      const bare = makeTransport(() => b64DataResponse([PNG_BYTES]));
      await make(bare.transport).generate({ prompt: "p", model: "black-forest-labs/FLUX.1-schnell" });
      const bareBody = sentJson(bare.calls[0]);
      expect("steps" in bareBody).toBe(false);
      expect("guidance_scale" in bareBody).toBe(false);
      expect("seed" in bareBody).toBe(false);
      expect("negative_prompt" in bareBody).toBe(false);
      // v1 requests never carry a count — `n` is never sent.
      expect("n" in bareBody).toBe(false);
    });

    it("omits width/height when no COMPLETE size is set (vendor default applies)", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);
      await backend.generate({ prompt: "p", model: "black-forest-labs/FLUX.1-schnell" });
      expect("width" in sentJson(calls[0])).toBe(false);
      expect("height" in sentJson(calls[0])).toBe(false);

      const partial = makeTransport(() => b64DataResponse([PNG_BYTES]));
      await make(partial.transport).generate({ prompt: "p", model: "black-forest-labs/FLUX.1-schnell", width: 1024 });
      const partialBody = sentJson(partial.calls[0]);
      expect("width" in partialBody).toBe(false);
      expect("height" in partialBody).toBe(false);
    });

    it("downloads a url data entry server-side through the seam", async () => {
      const imageUrl = "https://api.together.ai/files/img.png";
      const { transport, calls } = makeTransport((url) =>
        url.href === imageUrl
          ? new Response(PNG_BYTES, { headers: { "content-type": "image/png" } })
          : Response.json({ created: 0, data: [{ url: imageUrl }] }),
      );
      const backend = make(transport);
      const result = await backend.generate({ prompt: "p", model: "black-forest-labs/FLUX.1-schnell" });
      expect(calls.map((call) => call.url)).toEqual([
        `${TOGETHER_ENDPOINT}/images/generations`,
        imageUrl,
      ]);
      expect(result.images[0].data.equals(PNG_BYTES)).toBe(true);
    });

    it("surfaces a non-2xx response as the family typed error with the status", async () => {
      const { transport } = makeTransport(() =>
        new Response(JSON.stringify({ message: "bad key" }), { status: 401 }),
      );
      const backend = make(transport);
      const promise = backend.generate({ prompt: "p", model: "black-forest-labs/FLUX.1-schnell" });
      await expect(promise).rejects.toBeInstanceOf(OpenAiImagesError);
      await expect(promise).rejects.toMatchObject({ status: 401 });
      await expect(promise).rejects.toThrow(/Together AI generation failed with HTTP 401/);
    });

    it("requires a model (request or profile config)", async () => {
      const { transport } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);
      await expect(backend.generate({ prompt: "p" })).rejects.toBeInstanceOf(OpenAiImagesConfigError);
    });
  });

  describe("listModels", () => {
    it("queries GET /models with Bearer and lists the catalog UNFILTERED (no documented image discriminator)", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({
          data: [
            { id: "black-forest-labs/FLUX.1-schnell" },
            { id: "black-forest-labs/FLUX.2-dev" },
            { id: "meta-llama/Llama-4-70B-Instruct" }, // LLM row — no discriminator documented → kept
          ],
        }),
      );
      const backend = make(transport);
      const models = await backend.listModels();
      expect(models.map((m) => m.id)).toEqual([
        "black-forest-labs/FLUX.1-schnell",
        "black-forest-labs/FLUX.2-dev",
        "meta-llama/Llama-4-70B-Instruct",
      ]);
      expect(calls[0].url).toBe(`${TOGETHER_ENDPOINT}/models`);
      expect(calls[0].init?.method).toBe("GET");
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tg-key");
    });
  });

  describe("probe", () => {
    it("reports ok with the unfiltered model count", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({ data: [{ id: "black-forest-labs/FLUX.1-schnell" }, { id: "meta-llama/x" }] }),
      );
      const backend = make(transport);
      const result = await backend.probe();
      expect(result).toEqual({ ok: true, detail: "2 models" });
      expect(calls[0].url).toBe(`${TOGETHER_ENDPOINT}/models`);
    });
  });

  describe("capability row + registry", () => {
    it("pins the Together AI capability row (card + 2026-09-18 delta)", () => {
      const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.TogetherAi];
      expect(caps.supportsNegativePrompt).toBe(true); // model-dependent caveat in the row comment
      expect(caps.supportsSamplers).toBe(false);
      expect(caps.supportsSeed).toBe(true);
      expect(caps.sizeSupport).toEqual({ kind: "free" });
      expect(caps.noApiKey).toBe(false);
      expect(caps.supportsLiveProgress).toBe(false);
      expect(caps.localExecution).toBe(false);
      expect(caps.paramRanges).toEqual({});
    });

    it("registers the togetherai slug at import time (creatable via the registry)", () => {
      const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.TogetherAi, {
        endpoint: TOGETHER_ENDPOINT,
        apiKey: "tg-key",
      });
      expect(typeof backend.generate).toBe("function");
      expect(typeof backend.listModels).toBe("function");
      expect(typeof backend.probe).toBe("function");
      expect(typeof backend.dispose).toBe("function");
    });
  });
});
