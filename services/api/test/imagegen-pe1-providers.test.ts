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
