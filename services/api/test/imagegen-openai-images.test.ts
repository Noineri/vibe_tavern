/**
 * Unit tests for the OpenAI Images image-gen adapter (IMAGE_GENERATION_PLAN
 * IG-6) — mocked transport at the config-injected fetch seam (tier T1: the
 * double is a function argument, no mock.module, no globalThis patches).
 * Every pinned request/response shape traces to the OpenAI card in
 * IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH (doc-verified 2026-09-07).
 */

import { describe, expect, it } from "bun:test";
import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import {
  OPENAI_IMAGES_SIZES,
  OpenAiImagesConfigError,
  OpenAiImagesError,
  OpenAiImagesSizeError,
  openAiImagesFactory,
} from "../src/domain/imagegen/backends/openai-images.js";
import {
  createImageGenBackend,
  IMAGE_GEN_BACKEND_CAPABILITIES,
} from "../src/domain/imagegen/imagegen-registry.js";

const ENDPOINT = "https://api.openai.com/v1";
const API_KEY = "oai-key";

/** Known 8-byte PNG-magic payload (sniffable as image/png). */
const PNG_BYTES = Buffer.from("iVBORw0KGgo=", "base64");
/** JFIF header bytes (sniffable as image/jpeg). */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
/** Minimal RIFF/WEBP container (sniffable as image/webp). */
const WEBP_BYTES = Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "latin1");

/** An images-generations response carrying `data[].b64_json`. */
function b64Response(buffers: Buffer[]): Response {
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

function backendWith(transport: typeof fetch) {
  return openAiImagesFactory({ endpoint: ENDPOINT, apiKey: API_KEY, fetch: transport });
}

describe("openai-images adapter", () => {
  describe("generate", () => {
    it("sends the card's images-generations body and decodes b64_json in-process", async () => {
      const { transport, calls } = makeTransport(() => b64Response([PNG_BYTES]));
      const backend = backendWith(transport);

      const result = await backend.generate({
        prompt: "a tavern at dusk",
        model: "gpt-image-1",
        width: 1024,
        height: 1024,
      });

      // ONE seam call: the generations POST — b64_json decodes in-process,
      // no second HTTP request (the GPT Image delivery shape).
      expect(calls.map((call) => call.url)).toEqual([`${ENDPOINT}/images/generations`]);
      const post = calls[0];
      expect(post.init?.method).toBe("POST");
      const headers = post.init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
      expect(headers["Content-Type"]).toBe("application/json");

      const body = sentJson(post);
      expect(body.model).toBe("gpt-image-1");
      expect(body.prompt).toBe("a tavern at dusk");
      expect(body.size).toBe("1024x1024");
      // GPT Image never receives response_format (card: DALL-E-only).
      expect("response_format" in body).toBe(false);

      expect(result.images).toHaveLength(1);
      expect(result.images[0].data.equals(PNG_BYTES)).toBe(true);
      expect(result.images[0].mimeType).toBe("image/png");
      // The grid meaning of the requested size echoes back.
      expect(result.width).toBe(1024);
      expect(result.height).toBe(1024);
    });

    it("sniffs jpeg and webp bytes, falling back to octet-stream", async () => {
      for (const [bytes, mime] of [
        [JPEG_BYTES, "image/jpeg"],
        [WEBP_BYTES, "image/webp"],
        [Buffer.from([0x00, 0x01, 0x02, 0x03]), "application/octet-stream"],
      ] as const) {
        const { transport } = makeTransport(() => b64Response([bytes]));
        const backend = backendWith(transport);
        const result = await backend.generate({ prompt: "p", model: "gpt-image-1" });
        expect(result.images[0].mimeType).toBe(mime);
      }
    });

    it("maps every documented W×H onto its size string", async () => {
      for (const [size, grid] of OPENAI_IMAGES_SIZES) {
        const [width, height] = size.split("x").map(Number);
        const { transport, calls } = makeTransport(() => b64Response([PNG_BYTES]));
        const backend = backendWith(transport);
        const result = await backend.generate({ prompt: "p", model: "gpt-image-1", width, height });
        expect(sentJson(calls[0]).size).toBe(size);
        expect(result.width).toBe(grid.width);
        expect(result.height).toBe(grid.height);
      }
    });

    it("keeps the adapter size table in lockstep with the registry capability grid", () => {
      const capability = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.OpenAiImages];
      expect(capability.sizeSupport.kind).toBe("vendor-set");
      if (capability.sizeSupport.kind !== "vendor-set") return;
      expect([...OPENAI_IMAGES_SIZES.keys()]).toEqual(capability.sizeSupport.sizes);
    });

    it("fails closed on an undocumented size before any transport call", async () => {
      const { transport, calls } = makeTransport(() => b64Response([PNG_BYTES]));
      const backend = backendWith(transport);
      await expect(backend.generate({ prompt: "p", model: "gpt-image-1", width: 999, height: 999 })).rejects.toBeInstanceOf(
        OpenAiImagesSizeError,
      );
      expect(calls).toHaveLength(0);
    });

    it("IG-20a: a user entry goes on the wire VERBATIM (arbitrary W×H is the vendor-documented gpt-image surface)", async () => {
      const { transport, calls } = makeTransport(() => b64Response([PNG_BYTES]));
      const backend = openAiImagesFactory({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        userSizes: [{ width: 1152, height: 896 }],
        fetch: transport,
      });
      const result = await backend.generate({ prompt: "p", model: "gpt-image-2", width: 1152, height: 896 });
      const body = sentJson(calls[0]);
      expect(body.size).toBe("1152x896");
      expect(result.width).toBe(1152);
      expect(result.height).toBe(896);
    });

    it("IG-20a: a ratio field on the entry is ignored (pixel-wire backend) and entries never weaken the grid", async () => {
      const { transport, calls } = makeTransport(() => b64Response([PNG_BYTES]));
      const backend = openAiImagesFactory({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        userSizes: [{ width: 1152, height: 896, ratio: "9:7" }],
        fetch: transport,
      });
      await backend.generate({ prompt: "p", model: "gpt-image-2", width: 1152, height: 896 });
      expect(sentJson(calls[0]).size).toBe("1152x896");
      // Off table AND off entries → still the fail-closed error.
      await expect(backend.generate({ prompt: "p", model: "gpt-image-2", width: 999, height: 999 })).rejects.toBeInstanceOf(
        OpenAiImagesSizeError,
      );
    });

    it("omits size when no complete size is set (vendor auto default applies)", async () => {
      const { transport, calls } = makeTransport(() => b64Response([PNG_BYTES]));
      const backend = backendWith(transport);
      await backend.generate({ prompt: "p", model: "gpt-image-1" });
      expect("size" in sentJson(calls[0])).toBe(false);

      // A partial W×H cannot map onto the grid — also omitted.
      const partial = makeTransport(() => b64Response([PNG_BYTES]));
      const partialBackend = backendWith(partial.transport);
      await partialBackend.generate({ prompt: "p", model: "gpt-image-1", width: 1024 });
      expect("size" in sentJson(partial.calls[0])).toBe(false);
    });

    it("sends response_format b64_json for dall-e models only (card: DALL-E-only field)", async () => {
      const { transport, calls } = makeTransport(() => b64Response([PNG_BYTES]));
      const backend = backendWith(transport);
      await backend.generate({ prompt: "p", model: "dall-e-3" });
      expect(sentJson(calls[0]).response_format).toBe("b64_json");
    });

    it("resolves the model from the profile config when the request carries none", async () => {
      const { transport, calls } = makeTransport(() => b64Response([PNG_BYTES]));
      const backend = openAiImagesFactory({
        endpoint: ENDPOINT,
        apiKey: API_KEY,
        model: "gpt-image-1-mini",
        fetch: transport,
      });
      await backend.generate({ prompt: "p" });
      expect(sentJson(calls[0]).model).toBe("gpt-image-1-mini");
    });

    it("downloads a url data entry server-side through the seam (DALL-E fallback)", async () => {
      const imageUrl = "https://api.openai.com/v1/files/img.png";
      const { transport, calls } = makeTransport((url) =>
        url.href === imageUrl
          ? new Response(PNG_BYTES, { headers: { "content-type": "image/png" } })
          : Response.json({ created: 0, data: [{ url: imageUrl }] }),
      );
      const backend = backendWith(transport);

      const result = await backend.generate({ prompt: "p", model: "dall-e-2" });

      // Two seam calls: the generations POST, then the server-side download.
      expect(calls.map((call) => call.url)).toEqual([`${ENDPOINT}/images/generations`, imageUrl]);
      expect(result.images[0].data.equals(PNG_BYTES)).toBe(true);
      expect(result.images[0].mimeType).toBe("image/png");
    });

    it("rejects a response with an empty or malformed data array", async () => {
      for (const payload of [
        { created: 0, data: [] },
        { created: 0, data: [{ revised_prompt: "no image" }] },
        { created: 0, data: [{ b64_json: "" }] },
        { created: 0, data: [{ b64_json: 42 }] },
        { created: 0, data: [{ url: "javascript:alert(1)" }] },
      ]) {
        const { transport } = makeTransport(() => Response.json(payload));
        const backend = backendWith(transport);
        await expect(backend.generate({ prompt: "p", model: "gpt-image-1" })).rejects.toBeInstanceOf(
          OpenAiImagesError,
        );
      }
    });

    it("surfaces a non-2xx generations response as a typed error with the status", async () => {
      const { transport } = makeTransport(() =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
      );
      const backend = backendWith(transport);
      const promise = backend.generate({ prompt: "p", model: "gpt-image-1" });
      await expect(promise).rejects.toBeInstanceOf(OpenAiImagesError);
      await expect(promise).rejects.toMatchObject({ status: 401 });
    });

    it("propagates an already-aborted signal as an AbortError (not wrapped)", async () => {
      const { transport } = makeTransport(() => b64Response([PNG_BYTES]));
      const backend = backendWith(transport);
      const controller = new AbortController();
      controller.abort();
      await expect(
        backend.generate({ prompt: "p", model: "gpt-image-1", signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("requires a model (request or profile config)", async () => {
      const { transport } = makeTransport(() => b64Response([PNG_BYTES]));
      const backend = backendWith(transport);
      await expect(backend.generate({ prompt: "p" })).rejects.toBeInstanceOf(OpenAiImagesConfigError);
    });

    it("requires endpoint and apiKey in the factory config", () => {
      expect(() => openAiImagesFactory({ endpoint: "", apiKey: API_KEY })).toThrow(OpenAiImagesConfigError);
      expect(() => openAiImagesFactory({ endpoint: ENDPOINT, apiKey: "" })).toThrow(OpenAiImagesConfigError);
    });

    it("tolerates a pasted /images/generations suffix and a trailing slash in the endpoint", async () => {
      const { transport, calls } = makeTransport(() => b64Response([PNG_BYTES]));
      const backend = openAiImagesFactory({
        endpoint: `${ENDPOINT}/images/generations/`,
        apiKey: API_KEY,
        fetch: transport,
      });
      await backend.generate({ prompt: "p", model: "gpt-image-1" });
      expect(calls[0].url).toBe(`${ENDPOINT}/images/generations`);
    });
  });

  describe("listModels", () => {
    it("queries /models and filters down to the card's image families", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({
          data: [
            { id: "gpt-image-2", object: "model", owned_by: "system" },
            { id: "gpt-image-1-mini", object: "model" },
            { id: "dall-e-3", object: "model" },
            { id: "gpt-5.2", object: "model" },
            { id: "text-embedding-3-small", object: "model" },
          ],
        }),
      );
      const backend = backendWith(transport);
      const models = await backend.listModels();
      expect(models).toEqual([
        { id: "gpt-image-2", label: "gpt-image-2" },
        { id: "gpt-image-1-mini", label: "gpt-image-1-mini" },
        { id: "dall-e-3", label: "dall-e-3" },
      ]);
      expect(calls[0].url).toBe(`${ENDPOINT}/models`);
      expect(calls[0].init?.method).toBe("GET");
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    });

    it("surfaces a non-2xx model list as a typed error with the status", async () => {
      const { transport } = makeTransport(() => new Response("nope", { status: 500 }));
      const backend = backendWith(transport);
      const promise = backend.listModels();
      await expect(promise).rejects.toBeInstanceOf(OpenAiImagesError);
      await expect(promise).rejects.toMatchObject({ status: 500 });
    });
  });

  describe("probe", () => {
    it("reports ok with the image-model count from /models", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({ data: [{ id: "gpt-image-2" }, { id: "dall-e-3" }, { id: "gpt-5.2" }] }),
      );
      const backend = backendWith(transport);
      const result = await backend.probe();
      expect(result).toEqual({ ok: true, detail: "2 image models" });
      expect(calls[0].url).toBe(`${ENDPOINT}/models`);
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
    it("registers the factory under the openai-images slug at import time", () => {
      // Importing the adapter module (top of this file) registers it — the
      // registry must now create instances for the slug (STT/TTS pattern).
      const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.OpenAiImages, {
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
