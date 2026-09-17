/**
 * Unit tests for the A1111-compatible image-gen adapter (IMAGE_GENERATION_PLAN
 * IG-7) — mocked transport at the config-injected fetch seam (tier T1: the
 * double is a function argument, no mock.module, no globalThis patches).
 * Every pinned request/response shape traces to the A1111 card in
 * IMAGE_GEN_LOCAL_BACKENDS_RESEARCH (doc-verified 2026-09-07).
 */

import { describe, expect, it } from "bun:test";
import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import {
  A1111ImageGenConfigError,
  A1111ImageGenError,
  A1111ImageGenSizeError,
  a1111Factory,
} from "../src/domain/imagegen/backends/a1111.js";
import {
  createImageGenBackend,
  IMAGE_GEN_BACKEND_CAPABILITIES,
} from "../src/domain/imagegen/imagegen-registry.js";

const ENDPOINT = "http://127.0.0.1:7860";
const SD_API_ROOT = `${ENDPOINT}/sdapi/v1`;
const BASIC_CREDENTIALS = "user:pass";

/** Known 8-byte PNG-magic payload (sniffable as image/png). */
const PNG_BYTES = Buffer.from("iVBORw0KGgo=", "base64");
/** JFIF header bytes (sniffable as image/jpeg). */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
/** Minimal RIFF/WEBP container (sniffable as image/webp). */
const WEBP_BYTES = Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "latin1");

/** A txt2img response carrying base64 PNG strings (the card's delivery
 *  shape: pure base64, no URLs). */
function imagesResponse(buffers: Buffer[]): Response {
  return Response.json({ images: buffers.map((buffer) => buffer.toString("base64")) });
}

/** Build the injected fetch double. Records every call; dispatches to
 *  `handler`; an already-aborted signal rejects like a real transport. */
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
    return handler(new URL(String(input)), init);
  };
  return { transport, calls };
}

/** Parse the recorded JSON body of a POST. */
function sentJson(call: RecordedCall): Record<string, unknown> {
  expect(call.init?.method).toBe("POST");
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function backendWith(transport: typeof fetch) {
  return a1111Factory({ endpoint: ENDPOINT, fetch: transport });
}

describe("a1111 adapter", () => {
  describe("generate", () => {
    it("sends only the set fields (card's override-only body) and decodes b64 images in-process", async () => {
      const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = backendWith(transport);

      const result = await backend.generate({
        prompt: "a tavern at dusk",
        negativePrompt: "blurry",
        model: "flux1-dev.safetensors",
        width: 1024,
        height: 768,
        steps: 28,
        cfgScale: 3.5,
        sampler: "Euler a",
        seed: 1234567890,
      });

      // ONE seam call: the txt2img POST — images decode in-process, pure
      // base64 (no URLs, no second HTTP request).
      expect(calls.map((call) => call.url)).toEqual([`${SD_API_ROOT}/txt2img`]);
      const post = calls[0];
      expect(post.init?.method).toBe("POST");
      const headers = post.init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      // Keyless server (no apiKey in config) — no auth header at all.
      expect("Authorization" in headers).toBe(false);

      // The exact card body: prompt + ONLY the set overrides + send_images.
      // No sampler_index (legacy), no clip_skip, no
      // override_settings_restore_afterwards — nothing invented.
      expect(sentJson(post)).toEqual({
        prompt: "a tavern at dusk",
        send_images: true,
        negative_prompt: "blurry",
        steps: 28,
        cfg_scale: 3.5,
        width: 1024,
        height: 768,
        seed: 1234567890,
        sampler_name: "Euler a",
        override_settings: { sd_model_checkpoint: "flux1-dev.safetensors" },
      });

      expect(result.images).toHaveLength(1);
      expect(result.images[0].data.equals(PNG_BYTES)).toBe(true);
      expect(result.images[0].mimeType).toBe("image/png");
      expect(result.width).toBe(1024);
      expect(result.height).toBe(768);
    });

    it("sends prompt + send_images ONLY for a minimal request (server defaults apply)", async () => {
      const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = backendWith(transport);
      await backend.generate({ prompt: "p" });
      expect(sentJson(calls[0])).toEqual({ prompt: "p", send_images: true });
    });

    it("sends the schedule type verbatim when set (PG-3) — absent means the server's own default", async () => {
      const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = backendWith(transport);
      await backend.generate({ prompt: "p", sampler: "DPM++ 2M", scheduler: "Karras" });
      expect(sentJson(calls[0])).toEqual({
        prompt: "p",
        send_images: true,
        sampler_name: "DPM++ 2M",
        scheduler: "Karras",
      });
    });

    it("sends width and height independently (free W×H, no coupled grid)", async () => {
      const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = backendWith(transport);
      await backend.generate({ prompt: "p", width: 912 });
      const body = sentJson(calls[0]);
      expect(body.width).toBe(912);
      expect("height" in body).toBe(false);
    });

    it("passes seed -1 through verbatim (the dialect's server-side random sentinel)", async () => {
      const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = backendWith(transport);
      await backend.generate({ prompt: "p", seed: -1 });
      expect(sentJson(calls[0]).seed).toBe(-1);
    });

    it("resolves the checkpoint from the profile config when the request carries none", async () => {
      const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = a1111Factory({ endpoint: ENDPOINT, model: "sd_xl_base.safetensors", fetch: transport });
      await backend.generate({ prompt: "p" });
      expect(sentJson(calls[0]).override_settings).toEqual({
        sd_model_checkpoint: "sd_xl_base.safetensors",
      });
    });

    it("prefers the request model over the profile config", async () => {
      const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = a1111Factory({ endpoint: ENDPOINT, model: "profile-model", fetch: transport });
      await backend.generate({ prompt: "p", model: "request-model" });
      expect(sentJson(calls[0]).override_settings).toEqual({ sd_model_checkpoint: "request-model" });
    });

    it("sends basic auth from the apiKey when present (card: --api-auth 'user:pass')", async () => {
      const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = a1111Factory({ endpoint: ENDPOINT, apiKey: BASIC_CREDENTIALS, fetch: transport });
      await backend.generate({ prompt: "p" });
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(
        `Basic ${Buffer.from(BASIC_CREDENTIALS, "utf-8").toString("base64")}`,
      );
    });

    it("fails closed on a non-positive or non-integer W×H before any transport call", async () => {
      for (const size of [0, -5, 10.5]) {
        const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
        const backend = backendWith(transport);
        await expect(backend.generate({ prompt: "p", width: size, height: 512 })).rejects.toBeInstanceOf(
          A1111ImageGenSizeError,
        );
        expect(calls).toHaveLength(0);
      }
    });

    it("sniffs jpeg and webp bytes, falling back to the card's documented png", async () => {
      for (const [bytes, mime] of [
        [JPEG_BYTES, "image/jpeg"],
        [WEBP_BYTES, "image/webp"],
        [Buffer.from([0x00, 0x01, 0x02, 0x03]), "image/png"],
      ] as const) {
        const { transport } = makeTransport(() => imagesResponse([bytes]));
        const backend = backendWith(transport);
        const result = await backend.generate({ prompt: "p" });
        expect(result.images[0].mimeType).toBe(mime);
      }
    });

    it("rejects a response with no usable images", async () => {
      for (const payload of [
        { images: [] },
        { images: ["", "not-empty-but-second-is-broken"] },
        { images: [42] },
        { created: 0, data: [{ b64_json: PNG_BYTES.toString("base64") }] },
        null,
      ]) {
        const { transport } = makeTransport(() => Response.json(payload));
        const backend = backendWith(transport);
        await expect(backend.generate({ prompt: "p" })).rejects.toBeInstanceOf(A1111ImageGenError);
      }
    });

    it("surfaces a non-2xx txt2img response as a typed error with the status", async () => {
      const { transport } = makeTransport(() =>
        new Response(JSON.stringify({ detail: "out of memory" }), { status: 500 }),
      );
      const backend = backendWith(transport);
      const promise = backend.generate({ prompt: "p" });
      await expect(promise).rejects.toBeInstanceOf(A1111ImageGenError);
      await expect(promise).rejects.toMatchObject({ status: 500 });
    });

    it("wraps a transport-level failure into the typed error (not a silent pass)", async () => {
      const failing = (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch;
      const backend = backendWith(failing);
      const promise = backend.generate({ prompt: "p" });
      await expect(promise).rejects.toBeInstanceOf(A1111ImageGenError);
      await expect(promise).rejects.toMatchObject({ name: "A1111ImageGenError" });
    });

    it("propagates an already-aborted signal as an AbortError (not wrapped)", async () => {
      const { transport } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = backendWith(transport);
      const controller = new AbortController();
      controller.abort();
      await expect(backend.generate({ prompt: "p", signal: controller.signal })).rejects.toMatchObject({
        name: "AbortError",
      });
    });

    it("requires an endpoint in the factory config (apiKey optional, keyless by default)", () => {
      expect(() => a1111Factory({ endpoint: "" })).toThrow(A1111ImageGenConfigError);
      expect(() => a1111Factory({ endpoint: "   " })).toThrow(A1111ImageGenConfigError);
    });

    it("tolerates a trailing slash, an explicit /sdapi/v1 root, and a pasted /txt2img path", async () => {
      for (const pasted of [
        `${ENDPOINT}/`,
        SD_API_ROOT,
        `${SD_API_ROOT}/txt2img`,
      ]) {
        const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
        const backend = a1111Factory({ endpoint: pasted, fetch: transport });
        await backend.generate({ prompt: "p" });
        expect(calls[0].url).toBe(`${SD_API_ROOT}/txt2img`);
      }
    });
  });

  describe("listModels", () => {
    it("queries /sd-models and maps title/model_name per checkpoint", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json([
          { title: "Flux1 Dev", model_name: "flux1-dev.safetensors", hash: "abc", sha256: null, filename: "flux1-dev.safetensors", config: null },
          { title: "", model_name: "sd_xl_base.safetensors" },
          { title: "Broken entry" },
        ]),
      );
      const backend = backendWith(transport);
      const models = await backend.listModels();
      expect(models).toEqual([
        { id: "flux1-dev.safetensors", label: "Flux1 Dev" },
        { id: "sd_xl_base.safetensors", label: "sd_xl_base.safetensors" },
      ]);
      expect(calls[0].url).toBe(`${SD_API_ROOT}/sd-models`);
      expect(calls[0].init?.method).toBe("GET");
    });

    it("sends basic auth on the model list when apiKey is present", async () => {
      const { transport, calls } = makeTransport(() => Response.json([]));
      const backend = a1111Factory({ endpoint: ENDPOINT, apiKey: BASIC_CREDENTIALS, fetch: transport });
      await backend.listModels();
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(
        `Basic ${Buffer.from(BASIC_CREDENTIALS, "utf-8").toString("base64")}`,
      );
    });

    it("surfaces a non-2xx model list as a typed error with the status", async () => {
      const { transport } = makeTransport(() => new Response("nope", { status: 500 }));
      const backend = backendWith(transport);
      const promise = backend.listModels();
      await expect(promise).rejects.toBeInstanceOf(A1111ImageGenError);
      await expect(promise).rejects.toMatchObject({ status: 500 });
    });
  });

  describe("listSamplers", () => {
    it("queries /samplers and maps {name, aliases} per entry", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json([
          { name: "Euler a", aliases: ["k_euler_a"], options: {} },
          { name: "DPM++ 2M", aliases: [], options: {} },
          { name: "NoAliasesSampler", options: {} },
          42,
        ]),
      );
      const backend = backendWith(transport);
      const samplers = await backend.listSamplers();
      expect(samplers).toEqual([
        { name: "Euler a", aliases: ["k_euler_a"] },
        { name: "DPM++ 2M", aliases: [] },
        { name: "NoAliasesSampler" },
      ]);
      expect(calls[0].url).toBe(`${SD_API_ROOT}/samplers`);
      expect(calls[0].init?.method).toBe("GET");
    });

    it("surfaces a non-2xx sampler list as a typed error with the status", async () => {
      const { transport } = makeTransport(() => new Response("nope", { status: 503 }));
      const backend = backendWith(transport);
      const promise = backend.listSamplers();
      await expect(promise).rejects.toBeInstanceOf(A1111ImageGenError);
      await expect(promise).rejects.toMatchObject({ status: 503 });
    });
  });

  describe("listSchedulers (PG-3)", () => {
    it("queries /schedulers and maps {name, label} per entry (nameless skipped)", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json([
          { name: "Automatic", label: "Automatic", aliases: null, options: {} },
          { name: "SGM Uniform", label: "SGM Uniform", options: {} },
          { label: "no-name" },
          "garbage",
        ]),
      );
      const backend = backendWith(transport);
      const schedulers = await backend.listSchedulers();
      expect(schedulers).toEqual([
        { name: "Automatic", label: "Automatic" },
        { name: "SGM Uniform", label: "SGM Uniform" },
      ]);
      expect(calls[0].url).toBe(`${SD_API_ROOT}/schedulers`);
      expect(calls[0].init?.method).toBe("GET");
    });

    it("surfaces a non-2xx scheduler list as a typed error with the status", async () => {
      const { transport } = makeTransport(() => new Response("nope", { status: 503 }));
      const backend = backendWith(transport);
      const promise = backend.listSchedulers();
      await expect(promise).rejects.toBeInstanceOf(A1111ImageGenError);
      await expect(promise).rejects.toMatchObject({ status: 503 });
    });
  });

  describe("listExtensions", () => {
    it("queries /extensions and maps name per entry (the ADetailer probe source)", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json([
          { name: "adetailer", dirname: "adetailer", enabled: true, builtin: false },
          { name: "sd-webui-controlnet", enabled: true, builtin: false },
          { dirname: "nameless", enabled: true, builtin: false },
          "garbage",
        ]),
      );
      const backend = backendWith(transport);
      const extensions = await backend.listExtensions();
      expect(extensions).toEqual(["adetailer", "sd-webui-controlnet"]);
      expect(calls[0].url).toBe(`${SD_API_ROOT}/extensions`);
      expect(calls[0].init?.method).toBe("GET");
    });

    it("surfaces a non-2xx extension list as a typed error with the status", async () => {
      const { transport } = makeTransport(() => new Response("nope", { status: 500 }));
      const backend = backendWith(transport);
      const promise = backend.listExtensions();
      await expect(promise).rejects.toBeInstanceOf(A1111ImageGenError);
      await expect(promise).rejects.toMatchObject({ status: 500 });
    });
  });

  describe("generate — ADetailer (IG-CF15/PG-4 v1)", () => {
    it("sends alwayson_scripts.ADetailer with the enable bool + ad_model dict when adetailerModel is set", async () => {
      const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = backendWith(transport);

      await backend.generate({ prompt: "a bard", adetailerModel: "face_yolov8s.pt" });

      // The extension script's own arg contract (source-pinned): a leading
      // enable bool + pydantic dict whose ad_model names the face detector.
      expect(sentJson(calls[0])).toEqual({
        prompt: "a bard",
        send_images: true,
        alwayson_scripts: {
          ADetailer: { args: [true, { ad_model: "face_yolov8s.pt" }] },
        },
      });
    });

    it("omits alwayson_scripts entirely when adetailerModel is absent or blank", async () => {
      const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = backendWith(transport);

      await backend.generate({ prompt: "a bard" });
      expect("alwayson_scripts" in sentJson(calls[0])).toBe(false);

      await backend.generate({ prompt: "a bard", adetailerModel: "   " });
      expect("alwayson_scripts" in sentJson(calls[1])).toBe(false);
    });
  });

  describe("progress", () => {
    it("returns a single-fetch snapshot of /progress per the card shape", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({
          progress: 0.42,
          eta_relative: 3.5,
          state: "sampling",
          current_image: "aGVsbG8=",
          textinfo: "",
        }),
      );
      const backend = backendWith(transport);
      const info = await backend.progress();
      expect(info).toEqual({ progress: 0.42, etaRelative: 3.5, state: "sampling", previewBase64: "aGVsbG8=" });
      expect(calls[0].url).toBe(`${SD_API_ROOT}/progress`);
      expect(calls[0].init?.method).toBe("GET");
    });

    it("omits preview/state/eta when absent, empty, or non-string (shape not card-documented)", async () => {
      const { transport } = makeTransport(() =>
        Response.json({ progress: 0, eta_relative: null, state: { job: "x" }, current_image: "" }),
      );
      const backend = backendWith(transport);
      const info = await backend.progress();
      expect(info).toEqual({ progress: 0 });
    });

    it("fails closed on a body without a numeric progress value", async () => {
      for (const payload of [null, {}, { progress: "half" }]) {
        const { transport } = makeTransport(() => Response.json(payload));
        const backend = backendWith(transport);
        await expect(backend.progress()).rejects.toBeInstanceOf(A1111ImageGenError);
      }
    });

    it("surfaces a non-2xx progress response as a typed error with the status", async () => {
      const { transport } = makeTransport(() => new Response("nope", { status: 500 }));
      const backend = backendWith(transport);
      const promise = backend.progress();
      await expect(promise).rejects.toBeInstanceOf(A1111ImageGenError);
      await expect(promise).rejects.toMatchObject({ status: 500 });
    });
  });

  describe("probe", () => {
    it("reports ok with the checkpoint count from /sd-models", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json([{ title: "A", model_name: "a.safetensors" }, { title: "B", model_name: "b.safetensors" }]),
      );
      const backend = backendWith(transport);
      const result = await backend.probe();
      expect(result).toEqual({ ok: true, detail: "2 checkpoints" });
      expect(calls[0].url).toBe(`${SD_API_ROOT}/sd-models`);
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
    it("registers the factory under the a1111 slug at import time", () => {
      // Importing the adapter module (top of this file) registers it — the
      // registry must now create instances for the slug (STT/TTS pattern).
      const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.A1111, { endpoint: ENDPOINT });
      expect(typeof backend.generate).toBe("function");
      expect(typeof backend.listModels).toBe("function");
      expect(typeof backend.listSamplers).toBe("function");
      expect(typeof backend.progress).toBe("function");
      expect(typeof backend.probe).toBe("function");
      expect(typeof backend.dispose).toBe("function");
    });

    it("stays in lockstep with the registry capability entry (free sizes, gated fields, keyless)", () => {
      const capability = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.A1111];
      expect(capability.sizeSupport.kind).toBe("free");
      // The fields this adapter actually sends are exactly the ones the
      // capability flags advertise.
      expect(capability.supportsNegativePrompt).toBe(true);
      expect(capability.supportsSamplers).toBe(true);
      expect(capability.supportsSeed).toBe(true);
      expect(capability.supportsLiveProgress).toBe(true);
      expect(capability.noApiKey).toBe(true);
    });
  });
});
