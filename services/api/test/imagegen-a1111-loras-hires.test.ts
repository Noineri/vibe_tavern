/**
 * FT-A4 unit tests for the A1111 dialect's LoRA + hires-fix surfaces —
 * mocked transport at the config-injected fetch seam (tier T1, the file's
 * own harness twin). Wire facts source-verified 2026-09-19 against the
 * upstream implementations (AUTOMATIC1111 master incl. Forge and the
 * Forge-Neo branch):
 * - GET /sdapi/v1/loras is registered by the BUILT-IN Lora extension
 *   (extensions-builtin/Lora/scripts/lora_script.py → create_lora_json)
 *   and answers [{name, alias, path, metadata}] — metadata is the
 *   embedded safetensors dict (family keys ss_base_model_version /
 *   modelspec.architecture, shared with the ComfyUI ladder).
 * - GET /sdapi/v1/upscalers answers [{name, model_name, model_path,
 *   model_url, scale}] — get_upscalers is identical across the family.
 * - txt2img hires fields: enable_hr / hr_upscaler / hr_scale /
 *   hr_second_pass_steps / denoising_strength (modules/processing.py).
 * - <lora:name:strength> tags parse as <lora:([^:]+): — positive prompt.
 */

import { describe, expect, it } from "bun:test";

import { a1111Factory } from "../src/domain/imagegen/backends/a1111.js";

const ENDPOINT = "http://127.0.0.1:7860";
const SD_API_ROOT = `${ENDPOINT}/sdapi/v1`;

/** Known 8-byte PNG-magic payload (sniffable as image/png). */
const PNG_BYTES = Buffer.from("iVBORw0KGgo=", "base64");

function imagesResponse(buffers: Buffer[]): Response {
  return Response.json({ images: buffers.map((buffer) => buffer.toString("base64")) });
}

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function makeTransport(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const transport = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return handler(new URL(String(input)), init);
  };
  return { transport, calls };
}

function sentJson(call: RecordedCall): Record<string, unknown> {
  expect(call.init?.method).toBe("POST");
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function backendWith(transport: typeof fetch) {
  return a1111Factory({ endpoint: ENDPOINT, fetch: transport });
}

describe("a1111 adapter — loras + hires (FT-A4)", () => {
  describe("generate — <lora:> prompt tags", () => {
    it("appends tags to the POSITIVE prompt in order (strength as the plain number); the negative is untouched", async () => {
      const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = backendWith(transport);

      await backend.generate({
        prompt: "a tavern at dusk",
        negativePrompt: "blurry",
        loras: [
          { name: "nijireol_krea2_v1_ep5", strength: 0.7 },
          { name: "dragonPony", strength: 1 },
        ],
      });

      const body = sentJson(calls[0]!);
      expect(body.prompt).toBe(
        "a tavern at dusk, <lora:nijireol_krea2_v1_ep5:0.7>, <lora:dragonPony:1>",
      );
      expect(body.negative_prompt).toBe("blurry");
    });

    it("an EMPTY loras array leaves the prompt verbatim (no dangling separator)", async () => {
      const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = backendWith(transport);

      await backend.generate({ prompt: "a tavern at dusk", loras: [] });

      const body = sentJson(calls[0]!);
      expect(body.prompt).toBe("a tavern at dusk");
    });
  });

  describe("generate — hires-fix wire fields", () => {
    it("presence sends enable_hr + ONLY the set knobs (server defaults fill the rest)", async () => {
      const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = backendWith(transport);

      await backend.generate({
        prompt: "a tavern at dusk",
        hires: {
          upscaler: "4x-UltraSharp",
          steps: 12,
          scale: 1.5,
          denoisingStrength: 0.4,
        },
      });

      const body = sentJson(calls[0]!);
      expect(body.enable_hr).toBe(true);
      expect(body.hr_upscaler).toBe("4x-UltraSharp");
      expect(body.hr_second_pass_steps).toBe(12);
      expect(body.hr_scale).toBe(1.5);
      expect(body.denoising_strength).toBe(0.4);
    });

    it("a PARTIAL hires object sends enable_hr + the carried knobs only", async () => {
      const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = backendWith(transport);

      await backend.generate({
        prompt: "a tavern at dusk",
        hires: { upscaler: "Latent", steps: 0 },
      });

      const body = sentJson(calls[0]!);
      expect(body.enable_hr).toBe(true);
      expect(body.hr_upscaler).toBe("Latent");
      // steps: 0 is the dialect's own "inherit first-pass steps" — a
      // carried value, sent verbatim, not treated as unset.
      expect(body.hr_second_pass_steps).toBe(0);
      expect(body.hr_scale).toBeUndefined();
      expect(body.denoising_strength).toBeUndefined();
    });

    it("NO hires object sends none of the hires fields (the server-defaults rule)", async () => {
      const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = backendWith(transport);

      await backend.generate({ prompt: "a tavern at dusk" });

      const body = sentJson(calls[0]!);
      expect("enable_hr" in body).toBe(false);
      expect("hr_upscaler" in body).toBe(false);
      expect("hr_second_pass_steps" in body).toBe(false);
      expect("hr_scale" in body).toBe(false);
      expect("denoising_strength" in body).toBe(false);
    });

    it("loras and hires ride the SAME request (tags + hires fields together)", async () => {
      const { transport, calls } = makeTransport(() => imagesResponse([PNG_BYTES]));
      const backend = backendWith(transport);

      await backend.generate({
        prompt: "a tavern at dusk",
        loras: [{ name: "detail-tweaker", strength: 0.9 }],
        hires: { scale: 2, denoisingStrength: 0.6 },
      });

      const body = sentJson(calls[0]!);
      expect(body.prompt).toBe("a tavern at dusk, <lora:detail-tweaker:0.9>");
      expect(body.enable_hr).toBe(true);
      expect(body.hr_scale).toBe(2);
      expect(body.denoising_strength).toBe(0.6);
    });
  });

  describe("listLoras", () => {
    it("maps {name, alias, path, metadata} onto entries; family rides the embedded metadata keys", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json([
          {
            name: "nijireol_krea2_v1_ep5",
            alias: "nijireol_krea2_v1_ep5",
            path: "N:\\loras\\nijireol_krea2_v1_ep5.safetensors",
            metadata: { "ss_base_model_version": "krea2" },
          },
          {
            name: "dragonPony",
            alias: "",
            path: "N:\\loras\\dragonPony.safetensors",
            metadata: { "modelspec.architecture": "stable-diffusion-xl-v1-base" },
          },
          {
            name: "plain_lora",
            alias: "plain_lora",
            path: "N:\\loras\\plain_lora.safetensors",
            metadata: {},
          },
          {
            name: "null_meta_lora",
            alias: "null_meta_lora",
            path: "N:\\loras\\null_meta_lora.safetensors",
            metadata: null,
          },
          { alias: "nameless", path: "N:\\loras\\nameless.safetensors" },
          "garbage-entry",
        ]),
      );
      const backend = backendWith(transport);

      const loras = await backend.listLoras();

      expect(calls[0]?.url).toBe(`${SD_API_ROOT}/loras`);
      expect(calls[0]?.init?.method).toBe("GET");
      expect(loras).toEqual([
        { name: "nijireol_krea2_v1_ep5", family: "Krea 2", triggerWords: [] },
        { name: "dragonPony", family: "SDXL", triggerWords: [] },
        { name: "plain_lora", family: null, triggerWords: [] },
        { name: "null_meta_lora", family: null, triggerWords: [] },
      ]);
    });

    it("an HTTP failure surfaces the adapter error with the status", async () => {
      const { transport } = makeTransport(() => new Response("nope", { status: 502 }));
      const backend = backendWith(transport);

      await expect(backend.listLoras()).rejects.toThrow("A1111 lora list failed with HTTP 502");
    });
  });

  describe("listUpscalers", () => {
    it("maps {name, model_name, model_path, model_url, scale} onto the hr_upscaler vocabulary", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json([
          { name: "None", model_name: "", model_path: null, model_url: null, scale: 1 },
          { name: "Latent", model_name: "", model_path: null, model_url: null, scale: 2 },
          {
            name: "4x-UltraSharp",
            model_name: "4x-UltraSharp",
            model_path: "N:\\models\\ESRGAN\\4x-UltraSharp.pth",
            model_url: null,
            scale: 4,
          },
          { model_name: "nameless-upscaler" },
          42,
        ]),
      );
      const backend = backendWith(transport);

      const upscalers = await backend.listUpscalers();

      expect(calls[0]?.url).toBe(`${SD_API_ROOT}/upscalers`);
      expect(calls[0]?.init?.method).toBe("GET");
      expect(upscalers).toEqual([{ name: "None" }, { name: "Latent" }, { name: "4x-UltraSharp" }]);
    });

    it("an HTTP failure surfaces the adapter error with the status", async () => {
      const { transport } = makeTransport(() => new Response("nope", { status: 500 }));
      const backend = backendWith(transport);

      await expect(backend.listUpscalers()).rejects.toThrow("A1111 upscaler list failed with HTTP 500");
    });
  });
});
