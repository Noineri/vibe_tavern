/**
 * Unit tests for the OpenRouter image-gen adapter (IMAGE_GENERATION_PLAN
 * IG-5) — mocked transport at the config-injected fetch seam (tier T1: the
 * double is a function argument, no mock.module, no globalThis patches).
 * Every pinned request/response shape traces to the OpenRouter card in
 * IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH (doc-verified 2026-09-07).
 */

import { describe, expect, it } from "bun:test";
import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import {
  OPENROUTER_IMAGE_SIZES,
  OpenRouterImageGenConfigError,
  OpenRouterImageGenError,
  OpenRouterImageGenSizeError,
  openRouterImageGenFactory,
} from "../src/domain/imagegen/backends/openrouter.js";
import {
  createImageGenBackend,
  IMAGE_GEN_BACKEND_CAPABILITIES,
} from "../src/domain/imagegen/imagegen-registry.js";

const ENDPOINT = "https://openrouter.ai/api/v1";
const API_KEY = "or-key";

/** Known 8-byte PNG-magic payload — the documented data-URL round trip. */
const PNG_BYTES = Buffer.from("iVBORw0KGgo=", "base64");
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

/** A chat-completions response carrying the documented image container. */
function completionsResponse(urls: string[]): Response {
  return Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          images: urls.map((url) => ({ image_url: { url } })),
        },
      },
    ],
  });
}

/** Build the injected fetch double. Records every call; dispatches by URL:
 *  the completions POST / models GET go to `handler`, data: URLs decode
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

function backendWith(transport: typeof fetch) {
  return openRouterImageGenFactory({ endpoint: ENDPOINT, apiKey: API_KEY, fetch: transport });
}

describe("openrouter image-gen adapter", () => {
  describe("generate", () => {
    it("sends the card's chat-completions body and downloads the data-URL image through the injected fetch", async () => {
      const { transport, calls } = makeTransport(() => completionsResponse([PNG_DATA_URL]));
      const backend = backendWith(transport);

      const result = await backend.generate({
        prompt: "a tavern at dusk",
        model: "google/gemini-2.5-flash-image",
        width: 1024,
        height: 1024,
      });

      // Two seam calls: the completions POST, then the server-side download.
      expect(calls.map((call) => call.url)).toEqual([
        `${ENDPOINT}/chat/completions`,
        PNG_DATA_URL,
      ]);
      const post = calls[0];
      expect(post.init?.method).toBe("POST");
      const headers = post.init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
      expect(headers["Content-Type"]).toBe("application/json");

      const body = sentJson(post);
      expect(body.model).toBe("google/gemini-2.5-flash-image");
      expect(body.modalities).toEqual(["image", "text"]);
      expect(body.messages).toEqual([{ role: "user", content: "a tavern at dusk" }]);
      expect(body.image_config).toEqual({ aspect_ratio: "1:1" });

      // Documented PNG data URL decoded to raw bytes server-side.
      expect(result.images).toHaveLength(1);
      expect(result.images[0].data.equals(PNG_BYTES)).toBe(true);
      expect(result.images[0].mimeType).toBe("image/png");
      // The grid meaning of the requested ratio echoes back as the size.
      expect(result.width).toBe(1024);
      expect(result.height).toBe(1024);
    });

    it("maps every documented W×H onto its aspect-ratio label", async () => {
      for (const [size, grid] of OPENROUTER_IMAGE_SIZES) {
        const [width, height] = size.split("x").map(Number);
        const { transport, calls } = makeTransport(() => completionsResponse([PNG_DATA_URL]));
        const backend = backendWith(transport);
        const result = await backend.generate({ prompt: "p", model: "m", width, height });
        const body = sentJson(calls[0]);
        expect(body.image_config).toEqual({ aspect_ratio: grid.ratio });
        expect(result.width).toBe(grid.width);
        expect(result.height).toBe(grid.height);
      }
    });

    it("keeps the adapter size table in lockstep with the registry capability grid", () => {
      const capability = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.OpenRouter];
      expect(capability.sizeSupport.kind).toBe("vendor-set");
      if (capability.sizeSupport.kind !== "vendor-set") return;
      expect([...OPENROUTER_IMAGE_SIZES.keys()]).toEqual(capability.sizeSupport.sizes);
    });

    it("fails closed on an undocumented size before any transport call", async () => {
      const { transport, calls } = makeTransport(() => completionsResponse([PNG_DATA_URL]));
      const backend = backendWith(transport);
      await expect(backend.generate({ prompt: "p", model: "m", width: 999, height: 999 })).rejects.toBeInstanceOf(
        OpenRouterImageGenSizeError,
      );
      expect(calls).toHaveLength(0);
    });

    it("IG-20a: a user entry WITH its vendor-announced ratio maps off-table pixels onto the wire", async () => {
      const { transport, calls } = makeTransport(() => completionsResponse([PNG_DATA_URL]));
      const backend = openRouterImageGenFactory({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        userSizes: [{ width: 1152, height: 896, ratio: "9:7" }],
        fetch: transport,
      });
      const result = await backend.generate({ prompt: "p", model: "m", width: 1152, height: 896 });
      const body = sentJson(calls[0]);
      // The wire carries the ANNOUNCED ratio string verbatim — pixel grids
      // never reduce to it upstream (864×1184 is "3:4", not "27:37").
      expect(body.image_config).toEqual({ aspect_ratio: "9:7" });
      expect(result.width).toBe(1152);
      expect(result.height).toBe(896);
    });

    it("IG-20a: a user entry WITHOUT a ratio is a configuration error, never a guess (fail-closed)", async () => {
      const { transport, calls } = makeTransport(() => completionsResponse([PNG_DATA_URL]));
      const backend = openRouterImageGenFactory({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        userSizes: [{ width: 1152, height: 896 }],
        fetch: transport,
      });
      await expect(
        backend.generate({ prompt: "p", model: "m", width: 1152, height: 896 }),
      ).rejects.toBeInstanceOf(OpenRouterImageGenSizeError);
      expect(calls).toHaveLength(0);
    });

    it("IG-20a: user entries never WEAKEN the grid — a pair outside table ∪ entries still fails closed", async () => {
      const { transport, calls } = makeTransport(() => completionsResponse([PNG_DATA_URL]));
      const backend = openRouterImageGenFactory({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        userSizes: [{ width: 1152, height: 896, ratio: "9:7" }],
        fetch: transport,
      });
      await expect(backend.generate({ prompt: "p", model: "m", width: 999, height: 999 })).rejects.toBeInstanceOf(
        OpenRouterImageGenSizeError,
      );
      expect(calls).toHaveLength(0);
    });

    it("omits image_config when no complete size is set (vendor default applies)", async () => {
      const { transport, calls } = makeTransport(() => completionsResponse([PNG_DATA_URL]));
      const backend = backendWith(transport);
      await backend.generate({ prompt: "p", model: "m" });
      const body = sentJson(calls[0]);
      expect("image_config" in body).toBe(false);

      // A partial W×H cannot map onto the grid — also omitted.
      const partial = makeTransport(() => completionsResponse([PNG_DATA_URL]));
      const partialBackend = backendWith(partial.transport);
      await partialBackend.generate({ prompt: "p", model: "m", width: 1024 });
      expect("image_config" in sentJson(partial.calls[0])).toBe(false);
    });

    it("resolves the model from the profile config when the request carries none", async () => {
      const { transport, calls } = makeTransport(() => completionsResponse([PNG_DATA_URL]));
      const backend = openRouterImageGenFactory({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        model: "profile-model",
        fetch: transport,
      });
      await backend.generate({ prompt: "p" });
      expect(sentJson(calls[0]).model).toBe("profile-model");
    });

    it("rejects a response with no images", async () => {
      const { transport } = makeTransport(() =>
        Response.json({ choices: [{ message: { role: "assistant", content: "no image" } }] }),
      );
      const backend = backendWith(transport);
      await expect(backend.generate({ prompt: "p", model: "m" })).rejects.toBeInstanceOf(OpenRouterImageGenError);
    });

    it("rejects a malformed data URL", async () => {
      const { transport } = makeTransport(() => completionsResponse(["data:image/png,not-base64"]));
      const backend = backendWith(transport);
      await expect(backend.generate({ prompt: "p", model: "m" })).rejects.toThrow(/malformed data URL/);
    });

    it("rejects an image URL that is neither a data URL nor http(s)", async () => {
      const { transport } = makeTransport(() => completionsResponse(["javascript:alert(1)"]));
      const backend = backendWith(transport);
      await expect(backend.generate({ prompt: "p", model: "m" })).rejects.toThrow(/unsupported image URL/);
    });

    it("surfaces a non-2xx completions response as a typed error with the status", async () => {
      const { transport } = makeTransport(() =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
      );
      const backend = backendWith(transport);
      const promise = backend.generate({ prompt: "p", model: "m" });
      await expect(promise).rejects.toBeInstanceOf(OpenRouterImageGenError);
      await expect(promise).rejects.toMatchObject({ status: 401 });
    });

    it("propagates an already-aborted signal as an AbortError (not wrapped)", async () => {
      const { transport } = makeTransport(() => completionsResponse([PNG_DATA_URL]));
      const backend = backendWith(transport);
      const controller = new AbortController();
      controller.abort();
      await expect(
        backend.generate({ prompt: "p", model: "m", signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("requires a model (request or profile config)", async () => {
      const { transport } = makeTransport(() => completionsResponse([PNG_DATA_URL]));
      const backend = backendWith(transport);
      await expect(backend.generate({ prompt: "p" })).rejects.toBeInstanceOf(OpenRouterImageGenConfigError);
    });

    it("requires endpoint and apiKey in the factory config", () => {
      expect(() => openRouterImageGenFactory({ endpoint: "", apiKey: API_KEY })).toThrow(OpenRouterImageGenConfigError);
      expect(() => openRouterImageGenFactory({ endpoint: ENDPOINT, apiKey: "" })).toThrow(
        OpenRouterImageGenConfigError,
      );
    });

    it("tolerates a pasted /chat/completions suffix and a trailing slash in the endpoint", async () => {
      const { transport, calls } = makeTransport(() => completionsResponse([PNG_DATA_URL]));
      const backend = openRouterImageGenFactory({
        endpoint: `${ENDPOINT}/chat/completions/`,
        apiKey: API_KEY,
        fetch: transport,
      });
      await backend.generate({ prompt: "p", model: "m" });
      expect(calls[0].url).toBe(`${ENDPOINT}/chat/completions`);
    });
  });

  describe("listModels", () => {
    it("queries the documented modality filter and parses OpenAI-compat entries with enrichment", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({
          data: [
            {
              id: "google/gemini-2.5-flash-image",
              name: "Gemini 2.5 Flash Image",
              description: "Image generation model",
              pricing: { prompt: "0", completion: "0" },
            },
            { id: "paid/model", pricing: { prompt: "0.004", completion: "0.008" } },
            { id: "bare/model" },
          ],
        }),
      );
      const backend = backendWith(transport);
      const models = await backend.listModels();
      expect(models).toEqual([
        {
          id: "google/gemini-2.5-flash-image",
          label: "Gemini 2.5 Flash Image",
          description: "Image generation model",
          isFree: true,
        },
        { id: "paid/model", label: "paid/model", isFree: false },
        { id: "bare/model", label: "bare/model" },
      ]);
      expect(calls[0].url).toBe(`${ENDPOINT}/models?output_modalities=image`);
      expect(calls[0].init?.method).toBe("GET");
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    });

    it("marks per-megapixel-priced models non-free even when text pricing is zero", async () => {
      const { transport } = makeTransport(() =>
        Response.json({
          data: [
            {
              id: "pixel/priced",
              pricing: { prompt: "0", completion: "0", image: "0.002" },
            },
            {
              id: "fully/free",
              pricing: { prompt: "0", completion: "0", image: "0" },
            },
          ],
        }),
      );
      const backend = backendWith(transport);
      const models = await backend.listModels();
      expect(models).toEqual([
        { id: "pixel/priced", label: "pixel/priced", isFree: false },
        { id: "fully/free", label: "fully/free", isFree: true },
      ]);
    });

    it("surfaces a non-2xx model list as a typed error with the status", async () => {
      const { transport } = makeTransport(() => new Response("nope", { status: 500 }));
      const backend = backendWith(transport);
      const promise = backend.listModels();
      await expect(promise).rejects.toBeInstanceOf(OpenRouterImageGenError);
      await expect(promise).rejects.toMatchObject({ status: 500 });
    });
  });

  describe("probe", () => {
    it("reports ok with the image-model count from the documented endpoint", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
      );
      const backend = backendWith(transport);
      const result = await backend.probe();
      expect(result).toEqual({ ok: true, detail: "3 image models" });
      expect(calls[0].url).toBe(`${ENDPOINT}/models?output_modalities=image`);
    });

    it("reports failure with the upstream status on non-2xx", async () => {
      const { transport } = makeTransport(() => new Response("denied", { status: 401 }));
      const backend = backendWith(transport);
      const result = await backend.probe();
      expect(result.ok).toBe(false);
      expect(result.status).toBe(401);
      expect(result.detail).toContain("401");
    });

    it("reports a transport-level failure without throwing", async () => {
      const failing = (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch;
      const backend = backendWith(failing);
      const result = await backend.probe();
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("ECONNREFUSED");
    });
  });

  describe("registry wiring", () => {
    it("registers the factory under the openrouter slug at import time", () => {
      // Importing the adapter module (top of this file) registers it — the
      // registry must now create instances for the slug (STT/TTS pattern).
      const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.OpenRouter, {
        endpoint: ENDPOINT,
        apiKey: API_KEY,
      });
      expect(typeof backend.generate).toBe("function");
      expect(typeof backend.listModels).toBe("function");
      expect(typeof backend.probe).toBe("function");
      expect(typeof backend.dispose).toBe("function");
    });
  });
});
