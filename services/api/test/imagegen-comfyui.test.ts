/**
 * Unit tests for the ComfyUI image-gen adapter (COMFYUI_BACKEND_PLAN CG-A1)
 * — mocked transport at the config-injected fetch seam (tier T1: the double
 * is a function argument, no mock.module, no globalThis patches). Every
 * pinned request/response shape traces to the live-verified research card
 * (reports/IMAGEGEN_POLISH_REPORT.md § PG-5, ComfyUI 0.36.0, 2026-09-18):
 * POST /prompt → {prompt_id, node_errors}, GET /history/{id} →
 * {[id]: {outputs, status}}, GET /view → bytes.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import {
  COMFY_HISTORY_POLL_INTERVAL_MS,
  COMFY_KREA2_CLIP_TYPE,
  COMFY_MODEL_TEMPLATES,
  COMFY_NODE_DEFAULTS,
  ComfyImageGenConfigError,
  ComfyImageGenError,
  ComfyImageGenSizeError,
  buildComfyCheckpointWorkflow,
  buildComfyKrea2Workflow,
  comfyImageGenFactory,
  normalizeComfyFamily,
} from "../src/domain/imagegen/backends/comfyui.js";

const ENDPOINT = "http://127.0.0.1:8188";

/** Known 8-byte PNG-magic payload (sniffable as image/png). */
const PNG_BYTES = Buffer.from("iVBORw0KGgo=", "base64");

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

/** Build the injected fetch double. Records every call; dispatches to
 *  `handler`; an already-aborted signal rejects like a real transport. */
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

function sentJson(call: RecordedCall): Record<string, unknown> {
  expect(call.init?.method).toBe("POST");
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

/** A completed history entry carrying one saved-image row. */
function historyDone(promptId: string, filename = "vt_imagegen_00001_.png"): Response {
  return Response.json({
    [promptId]: {
      outputs: { "9": { images: [{ filename, subfolder: "", type: "output" }] } },
      status: { status_str: "success", completed: true, messages: [] },
    },
  });
}

/** The queued-prompt acknowledgment (no node errors). */
function queuedOk(promptId: string): Response {
  return Response.json({ prompt_id: promptId, number: 1, node_errors: {} });
}

/** A `GET /object_info/{node}` response exposing one required combo input
 *  with the given accepted values (template detection's ground truth). */
function objectInfoResponse(nodeName: string, inputName: string, values: string[]): Response {
  return Response.json({ [nodeName]: { input: { required: { [inputName]: [values, {}] } } } });
}

/** The checkpoint combo list the happy-path transports serve — every model
 *  id the tests reference must live here for detection to pass. */
const HAPPY_CHECKPOINTS = ["graycolor_v18.safetensors", "m.safetensors", "missing.safetensors"];

/** A full happy-path transport: template detection → /prompt → /history
 *  (pending then done) → /view (PNG bytes). URL-dispatched so the calls
 *  stay distinct. */
function happyTransport(promptId: string, pendingPolls = 0, checkpoints: string[] = HAPPY_CHECKPOINTS) {
  let polls = 0;
  return makeTransport((url) => {
    if (url.pathname === "/object_info/CheckpointLoaderSimple") {
      return objectInfoResponse("CheckpointLoaderSimple", "ckpt_name", checkpoints);
    }
    if (url.pathname === "/prompt") return queuedOk(promptId);
    if (url.pathname === `/history/${promptId}`) {
      polls += 1;
      return polls <= pendingPolls ? Response.json({}) : historyDone(promptId);
    }
    if (url.pathname === "/view") return new Response(new Uint8Array(PNG_BYTES));
    return new Response("not found", { status: 404 });
  });
}

/** A DiT happy-path transport: the model misses the checkpoint combo and
 *  hits the UNET combo; sidecar folders serve configurable lists. */
function ditTransport(
  promptId: string,
  folders: { encoders?: string[]; vaes?: string[]; unets?: string[]; checkpoints?: string[] } = {},
) {
  return makeTransport((url) => {
    if (url.pathname === "/object_info/CheckpointLoaderSimple") {
      return objectInfoResponse(
        "CheckpointLoaderSimple",
        "ckpt_name",
        folders.checkpoints ?? ["graycolor_v18.safetensors"],
      );
    }
    if (url.pathname === "/object_info/UNETLoader") {
      return objectInfoResponse(
        "UNETLoader",
        "unet_name",
        folders.unets ?? ["museByStableYogi_v35Int8Extended.safetensors", "kreation.safetensors"],
      );
    }
    if (url.pathname === "/models/text_encoders") {
      return Response.json(folders.encoders ?? ["qwen3vl_4b_fp8_scaled.safetensors", "t5xxl_fp16.safetensors"]);
    }
    if (url.pathname === "/models/vae") {
      return Response.json(folders.vaes ?? ["qwen_image_vae.safetensors", "sdxl_vae.safetensors"]);
    }
    if (url.pathname === "/prompt") return queuedOk(promptId);
    if (url.pathname === `/history/${promptId}`) return historyDone(promptId);
    if (url.pathname === "/view") return new Response(new Uint8Array(PNG_BYTES));
    return new Response("not found", { status: 404 });
  });
}

function backendWith(transport: typeof fetch, overrides: Record<string, unknown> = {}) {
  return comfyImageGenFactory({ endpoint: ENDPOINT, fetch: transport, ...overrides });
}

describe("comfyui adapter", () => {
  describe("buildComfyCheckpointWorkflow (pure template)", () => {
    it("maps the flat request onto the checkpoint graph with wired node links", () => {
      const { graph, seed } = buildComfyCheckpointWorkflow(
        {
          prompt: "a tavern at dusk",
          negativePrompt: "blurry",
          model: "graycolor_v18.safetensors",
          width: 832,
          height: 1216,
          steps: 8,
          cfgScale: 1,
          sampler: "euler_ancestral",
          scheduler: "simple",
          seed: 42,
        },
        "graycolor_v18.safetensors",
      );
      expect(seed).toBe(42);
      expect(graph["3"]).toEqual({
        class_type: "KSampler",
        inputs: {
          seed: 42,
          steps: 8,
          cfg: 1,
          sampler_name: "euler_ancestral",
          scheduler: "simple",
          denoise: 1,
          model: ["4", 0],
          positive: ["6", 0],
          negative: ["7", 0],
          latent_image: ["5", 0],
        },
      });
      expect(graph["4"]).toEqual({
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: "graycolor_v18.safetensors" },
      });
      expect(graph["5"]).toEqual({
        class_type: "EmptyLatentImage",
        inputs: { width: 832, height: 1216, batch_size: 1 },
      });
      expect(graph["6"]).toEqual({
        class_type: "CLIPTextEncode",
        inputs: { text: "a tavern at dusk", clip: ["4", 1] },
      });
      expect(graph["7"]).toEqual({
        class_type: "CLIPTextEncode",
        inputs: { text: "blurry", clip: ["4", 1] },
      });
      expect(graph["8"]).toEqual({
        class_type: "VAEDecode",
        inputs: { samples: ["3", 0], vae: ["4", 2] },
      });
      expect(graph["9"]).toEqual({
        class_type: "SaveImage",
        inputs: { filename_prefix: "vt_imagegen", images: ["8", 0] },
      });
      // No clipSkip → no CLIPSetLastLayer node at all.
      expect(graph["10"]).toBeUndefined();
    });

    it("materializes the node-class defaults for unset fields (the server's own /object_info values)", () => {
      const { graph, seed } = buildComfyCheckpointWorkflow({ prompt: "p" }, "m.safetensors");
      expect(graph["3"]!.inputs.steps).toBe(COMFY_NODE_DEFAULTS.steps);
      expect(graph["3"]!.inputs.cfg).toBe(COMFY_NODE_DEFAULTS.cfg);
      expect(graph["3"]!.inputs.sampler_name).toBe(COMFY_NODE_DEFAULTS.samplerName);
      expect(graph["3"]!.inputs.scheduler).toBe(COMFY_NODE_DEFAULTS.scheduler);
      expect(graph["5"]!.inputs.width).toBe(COMFY_NODE_DEFAULTS.latentWidth);
      expect(graph["5"]!.inputs.height).toBe(COMFY_NODE_DEFAULTS.latentHeight);
      // Unset seed → resolved client-side to a safe random integer.
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(seed)).toBe(true);
      expect(graph["3"]!.inputs.seed).toBe(seed);
      // Unset negative prompt → empty text (the node requires the input).
      expect(graph["7"]!.inputs.text).toBe("");
    });

    it("resolves the -1 random sentinel client-side (ComfyUI has no server sentinel)", () => {
      const { seed } = buildComfyCheckpointWorkflow({ prompt: "p", seed: -1 }, "m.safetensors");
      expect(seed).not.toBe(-1);
      expect(seed).toBeGreaterThanOrEqual(0);
    });

    it("wires CLIPSetLastLayer only when clipSkip is set, counting from the end", () => {
      const { graph } = buildComfyCheckpointWorkflow({ prompt: "p", clipSkip: 2 }, "m.safetensors");
      expect(graph["10"]).toEqual({
        class_type: "CLIPSetLastLayer",
        inputs: { stop_at_clip_layer: -2, clip: ["4", 1] },
      });
      expect(graph["6"]!.inputs.clip).toEqual(["10", 0]);
      expect(graph["7"]!.inputs.clip).toEqual(["10", 0]);
    });

    it("fail-closes on non-positive sizes", () => {
      expect(() => buildComfyCheckpointWorkflow({ prompt: "p", width: 0 }, "m.safetensors")).toThrow(
        ComfyImageGenSizeError,
      );
      expect(() => buildComfyCheckpointWorkflow({ prompt: "p", height: 12.5 }, "m.safetensors")).toThrow(
        ComfyImageGenSizeError,
      );
    });
  });

  describe("buildComfyKrea2Workflow (pure DiT template, CG-A2)", () => {
    const SIDECARS = {
      unet: "museByStableYogi_v35Int8Extended.safetensors",
      encoder: "qwen3vl_4b_fp8_scaled.safetensors",
      vae: "qwen_image_vae.safetensors",
    };

    it("maps the flat request onto the DiT graph with separate loaders wired in", () => {
      const { graph, seed } = buildComfyKrea2Workflow(
        {
          prompt: "a tavern at dusk",
          negativePrompt: "blurry",
          width: 832,
          height: 1216,
          steps: 8,
          cfgScale: 1,
          sampler: "euler",
          scheduler: "simple",
          seed: 42,
        },
        SIDECARS,
      );
      expect(seed).toBe(42);
      expect(graph["3"]!.inputs.model).toEqual(["11", 0]);
      expect(graph["11"]).toEqual({
        class_type: "UNETLoader",
        inputs: {
          unet_name: "museByStableYogi_v35Int8Extended.safetensors",
          // REQUIRED on ComfyUI 0.36+ — the live portrait test's catch.
          weight_dtype: COMFY_NODE_DEFAULTS.unetWeightDtype,
        },
      });
      expect(graph["12"]).toEqual({
        class_type: "CLIPLoader",
        inputs: { clip_name: "qwen3vl_4b_fp8_scaled.safetensors", type: "krea2" },
      });
      expect(graph["13"]).toEqual({
        class_type: "VAELoader",
        inputs: { vae_name: "qwen_image_vae.safetensors" },
      });
      // The sampler half keeps the shared ladder: same defaults, same ids.
      expect(graph["3"]!.inputs.steps).toBe(8);
      expect(graph["3"]!.inputs.cfg).toBe(1);
      expect(graph["5"]!.inputs.width).toBe(832);
      expect(graph["5"]!.inputs.height).toBe(1216);
      // Encoders read the CLIPLoader output; VAEDecode reads the VAELoader.
      expect(graph["6"]!.inputs.clip).toEqual(["12", 0]);
      expect(graph["7"]!.inputs.clip).toEqual(["12", 0]);
      expect(graph["8"]!.inputs.vae).toEqual(["13", 0]);
      expect(graph["4"]).toBeUndefined();
    });

    it("hardcodes CLIPLoader.type=krea2 (the owner's SM lesson: a qwen3vl encoder under type qwen_image is a silently-broken graph)", () => {
      const { graph } = buildComfyKrea2Workflow({ prompt: "p" }, SIDECARS);
      expect(graph["12"]!.inputs.type).toBe(COMFY_KREA2_CLIP_TYPE);
      expect(graph["12"]!.inputs.type).not.toBe("qwen_image");
    });

    it("wires CLIPSetLastLayer between the CLIPLoader and the encoders when clipSkip is set", () => {
      const { graph } = buildComfyKrea2Workflow({ prompt: "p", clipSkip: 2 }, SIDECARS);
      expect(graph["10"]).toEqual({
        class_type: "CLIPSetLastLayer",
        inputs: { stop_at_clip_layer: -2, clip: ["12", 0] },
      });
      expect(graph["6"]!.inputs.clip).toEqual(["10", 0]);
      expect(graph["7"]!.inputs.clip).toEqual(["10", 0]);
    });

    it("fail-closes on non-positive sizes (the shared ladder)", () => {
      expect(() => buildComfyKrea2Workflow({ prompt: "p", height: -4 }, SIDECARS)).toThrow(
        ComfyImageGenSizeError,
      );
    });
  });

  describe("LoRA chain wire (CG-C2)", () => {
    it("threads enabled loras as chained LoraLoader nodes between the checkpoint and the sampler half", () => {
      const { graph } = buildComfyCheckpointWorkflow(
        {
          prompt: "a tavern",
          loras: [
            { name: "nijireol_krea2_v1.safetensors", strength: 1.2 },
            { name: "detail_tweaker.safetensors", strength: 0.8 },
          ],
        },
        "graycolor_v18.safetensors",
      );
      // Node 20: fed by the checkpoint's own MODEL/CLIP outputs.
      expect(graph["20"]).toEqual({
        class_type: "LoraLoader",
        inputs: {
          lora_name: "nijireol_krea2_v1.safetensors",
          strength_model: 1.2,
          strength_clip: 1.2,
          model: ["4", 0],
          clip: ["4", 1],
        },
      });
      // Node 21: chained off node 20's outputs.
      expect(graph["21"]).toEqual({
        class_type: "LoraLoader",
        inputs: {
          lora_name: "detail_tweaker.safetensors",
          strength_model: 0.8,
          strength_clip: 0.8,
          model: ["20", 0],
          clip: ["20", 1],
        },
      });
      // The sampler half consumes the CHAIN's tail, never the loader.
      expect(graph["3"]!.inputs.model).toEqual(["21", 0]);
      expect(graph["6"]!.inputs.clip).toEqual(["21", 1]);
      expect(graph["7"]!.inputs.clip).toEqual(["21", 1]);
      // The VAE never threads through the chain (no VAE input on
      // LoraLoader) — the checkpoint's bundled third output stays wired.
      expect(graph["8"]!.inputs.vae).toEqual(["4", 2]);
    });

    it("threads the DiT template's UNET/CLIP through the chain; CLIPSetLastLayer reads the chain tail", () => {
      const { graph } = buildComfyKrea2Workflow(
        {
          prompt: "a tavern",
          clipSkip: 2,
          loras: [{ name: "nijireol_krea2_v1.safetensors", strength: 1.2 }],
        },
        { unet: "muse.safetensors", encoder: "qwen3vl_4b_fp8_scaled.safetensors", vae: "qwen_image_vae.safetensors" },
      );
      expect(graph["20"]).toEqual({
        class_type: "LoraLoader",
        inputs: {
          lora_name: "nijireol_krea2_v1.safetensors",
          strength_model: 1.2,
          strength_clip: 1.2,
          model: ["11", 0],
          clip: ["12", 0],
        },
      });
      expect(graph["3"]!.inputs.model).toEqual(["20", 0]);
      // The layer slice sits BETWEEN the chain and the encoders.
      expect(graph["10"]!.inputs.clip).toEqual(["20", 1]);
      expect(graph["6"]!.inputs.clip).toEqual(["10", 0]);
      expect(graph["7"]!.inputs.clip).toEqual(["10", 0]);
      expect(graph["8"]!.inputs.vae).toEqual(["13", 0]);
    });

    it("an empty lora list adds NO nodes — the graph stays the pre-C2 shape", () => {
      const { graph } = buildComfyCheckpointWorkflow({ prompt: "a tavern", loras: [] }, "graycolor_v18.safetensors");
      expect(graph["20"]).toBeUndefined();
      expect(graph["3"]!.inputs.model).toEqual(["4", 0]);
      expect(graph["6"]!.inputs.clip).toEqual(["4", 1]);
    });
  });

  describe("generate", () => {
    it("queues the graph, polls history to completion, downloads the bytes server-side", async () => {
      const { transport, calls } = happyTransport("pid-1");
      const backend = backendWith(transport);

      const result = await backend.generate({
        prompt: "a tavern at dusk",
        model: "graycolor_v18.safetensors",
        width: 512,
        height: 512,
        seed: 42,
      });

      // Template detection: the checkpoint combo is the first wire call.
      expect(calls[0]!.url).toBe(`${ENDPOINT}/object_info/CheckpointLoaderSimple`);
      // POST /prompt body: the workflow graph + a client id.
      expect(calls[1]!.url).toBe(`${ENDPOINT}/prompt`);
      const queued = sentJson(calls[1]!);
      expect(queued.client_id).toMatch(/^[\da-f-]{36}$/);
      const graph = queued.prompt as Record<string, { class_type: string }>;
      expect(graph["4"]!.class_type).toBe("CheckpointLoaderSimple");
      // History poll targets the queued prompt id.
      expect(calls[2]!.url).toBe(`${ENDPOINT}/history/pid-1`);
      // /view carries the row's fields as query params.
      const view = new URL(calls[3]!.url);
      expect(view.pathname).toBe("/view");
      expect(view.searchParams.get("filename")).toBe("vt_imagegen_00001_.png");
      expect(view.searchParams.get("subfolder")).toBe("");
      expect(view.searchParams.get("type")).toBe("output");
      // Result: downloaded bytes + sniffed MIME + resolved seed + W/H echo
      // + the resolved template id (CG-A2 provenance input).
      expect(result.images).toHaveLength(1);
      expect(result.images[0]!.mimeType).toBe("image/png");
      expect(result.images[0]!.data.equals(PNG_BYTES)).toBe(true);
      expect(result.seed).toBe(42);
      expect(result.width).toBe(512);
      expect(result.height).toBe(512);
      expect(result.resolvedTemplate).toBe("checkpoint");
    });

    it("keeps polling until the history entry turns terminal", async () => {
      const { transport, calls } = happyTransport("pid-2", 1);
      const backend = backendWith(transport);
      const result = await backend.generate({ prompt: "p", model: "m.safetensors" });
      expect(result.images).toHaveLength(1);
      const polls = calls.filter((call) => call.url.includes("/history/"));
      expect(polls.length).toBe(2);
    }, 5000);

    it("surfaces a graph rejection (node_errors) as a caller-class 400 error", async () => {
      const { transport } = makeTransport((url) => {
        if (url.pathname === "/object_info/CheckpointLoaderSimple") {
          return objectInfoResponse("CheckpointLoaderSimple", "ckpt_name", ["missing.safetensors"]);
        }
        return Response.json({
          prompt_id: "pid-3",
          number: 1,
          node_errors: { "4": { errors: [{ type: "value_not_in_list" }] } },
        });
      });
      const backend = backendWith(transport);
      let caught: unknown;
      try {
        await backend.generate({ prompt: "p", model: "missing.safetensors" });
      } catch (error) {
        caught = error;
      }
      expect(caught instanceof ComfyImageGenError).toBe(true);
      expect((caught as ComfyImageGenError).status).toBe(400);
      expect((caught as Error).message).toContain("node 4");
    });

    it("maps an execution_error history entry to its readable reason", async () => {
      const { transport } = makeTransport((url) => {
        if (url.pathname === "/object_info/CheckpointLoaderSimple") {
          return objectInfoResponse("CheckpointLoaderSimple", "ckpt_name", ["m.safetensors"]);
        }
        if (url.pathname === "/prompt") return queuedOk("pid-4");
        return Response.json({
          "pid-4": {
            outputs: {},
            status: {
              status_str: "error",
              completed: false,
              messages: [
                [
                  "execution_error",
                  { node_id: "3", node_type: "KSampler", exception_message: "CUDA out of memory" },
                ],
              ],
            },
          },
        });
      });
      const backend = backendWith(transport);
      let caught: unknown;
      try {
        await backend.generate({ prompt: "p", model: "m.safetensors" });
      } catch (error) {
        caught = error;
      }
      expect(caught instanceof ComfyImageGenError).toBe(true);
      expect((caught as Error).message).toContain("KSampler");
      expect((caught as Error).message).toContain("CUDA out of memory");
    });

    it("fails closed when the prompt completed without SaveImage outputs", async () => {
      const { transport } = makeTransport((url) => {
        if (url.pathname === "/object_info/CheckpointLoaderSimple") {
          return objectInfoResponse("CheckpointLoaderSimple", "ckpt_name", ["m.safetensors"]);
        }
        if (url.pathname === "/prompt") return queuedOk("pid-5");
        return Response.json({
          "pid-5": { outputs: {}, status: { status_str: "success", completed: true, messages: [] } },
        });
      });
      const backend = backendWith(transport);
      await expect(backend.generate({ prompt: "p", model: "m.safetensors" })).rejects.toThrow(
        /no output/,
      );
    });

    it("requires a checkpoint (no loaded-model state exists in ComfyUI)", async () => {
      const { transport } = happyTransport("pid-6");
      const backend = comfyImageGenFactory({ endpoint: ENDPOINT, fetch: transport });
      await expect(backend.generate({ prompt: "p" })).rejects.toThrow(ComfyImageGenConfigError);
    });

    it("an enabled lora absent from the live combo fails closed naming it (CG-C2)", async () => {
      const { transport } = makeTransport((url) => {
        if (url.pathname === "/object_info/CheckpointLoaderSimple") {
          return objectInfoResponse("CheckpointLoaderSimple", "ckpt_name", HAPPY_CHECKPOINTS);
        }
        if (url.pathname === "/object_info/LoraLoader") {
          return objectInfoResponse("LoraLoader", "lora_name", ["real_lora.safetensors"]);
        }
        return new Response("not found", { status: 404 });
      });
      const backend = backendWith(transport);
      let caught: unknown;
      try {
        await backend.generate({
          prompt: "p",
          model: "graycolor_v18.safetensors",
          loras: [{ name: "ghost_lora.safetensors", strength: 1 }],
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ComfyImageGenConfigError);
      expect((caught as ComfyImageGenConfigError).message).toContain("ghost_lora.safetensors");
    });

    it("a valid lora rides the queued graph as a LoraLoader node (CG-C2)", async () => {
      const { transport, calls } = makeTransport((url) => {
        if (url.pathname === "/object_info/CheckpointLoaderSimple") {
          return objectInfoResponse("CheckpointLoaderSimple", "ckpt_name", HAPPY_CHECKPOINTS);
        }
        if (url.pathname === "/object_info/LoraLoader") {
          return objectInfoResponse("LoraLoader", "lora_name", ["nijireol_krea2_v1.safetensors"]);
        }
        if (url.pathname === "/prompt") return queuedOk("pid-lora");
        if (url.pathname === "/history/pid-lora") return historyDone("pid-lora");
        if (url.pathname === "/view") return new Response(new Uint8Array(PNG_BYTES));
        return new Response("not found", { status: 404 });
      });
      const backend = backendWith(transport);
      const result = await backend.generate({
        prompt: "a tavern",
        model: "graycolor_v18.safetensors",
        loras: [{ name: "nijireol_krea2_v1.safetensors", strength: 1.2 }],
      });
      expect(result.images.length).toBe(1);
      const queueBody = sentJson(calls.find((c) => new URL(c.url).pathname === "/prompt")!);
      const graph = queueBody.prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      expect(graph["20"]).toEqual({
        class_type: "LoraLoader",
        inputs: {
          lora_name: "nijireol_krea2_v1.safetensors",
          strength_model: 1.2,
          strength_clip: 1.2,
          model: ["4", 0],
          clip: ["4", 1],
        },
      });
      expect(graph["3"]!.inputs.model).toEqual(["20", 0]);
    });

    it("maps a non-2xx /prompt to the upstream status", async () => {
      const { transport } = makeTransport((url) => {
        if (url.pathname === "/object_info/CheckpointLoaderSimple") {
          return objectInfoResponse("CheckpointLoaderSimple", "ckpt_name", ["m.safetensors"]);
        }
        return new Response("boom", { status: 500 });
      });
      const backend = backendWith(transport);
      let caught: unknown;
      try {
        await backend.generate({ prompt: "p", model: "m.safetensors" });
      } catch (error) {
        caught = error;
      }
      expect(caught instanceof ComfyImageGenError).toBe(true);
      expect((caught as ComfyImageGenError).status).toBe(500);
    });

    it("rethrows the caller's abort untouched while polling", async () => {
      const controller = new AbortController();
      const { transport } = makeTransport((url) => {
        if (url.pathname === "/object_info/CheckpointLoaderSimple") {
          return objectInfoResponse("CheckpointLoaderSimple", "ckpt_name", ["m.safetensors"]);
        }
        if (url.pathname === "/prompt") return queuedOk("pid-7");
        return Response.json({}); // pending forever
      });
      const backend = backendWith(transport);
      setTimeout(() => controller.abort(), Math.floor(COMFY_HISTORY_POLL_INTERVAL_MS / 4));
      let caught: unknown;
      try {
        await backend.generate({ prompt: "p", model: "m.safetensors", signal: controller.signal });
      } catch (error) {
        caught = error;
      }
      expect(caught instanceof Error && caught.name === "AbortError").toBe(true);
    }, 5000);

    it("tolerates pasted trailing slashes and a /prompt suffix on the endpoint", async () => {
      const { transport, calls } = happyTransport("pid-8");
      const backend = comfyImageGenFactory({ endpoint: `${ENDPOINT}/`, fetch: transport });
      await backend.generate({ prompt: "p", model: "m.safetensors" });
      expect(calls.some((call) => call.url === `${ENDPOINT}/prompt`)).toBe(true);
    });
  });

  describe("generate (krea2 DiT path, CG-A2)", () => {
    const MUSE = "museByStableYogi_v35Int8Extended.safetensors";

    it("auto-detects the DiT model, resolves canonical sidecars, and reports the template", async () => {
      const { transport, calls } = ditTransport("pid-d1");
      const backend = backendWith(transport);

      const result = await backend.generate({ prompt: "p", model: MUSE, seed: 7 });

      // Detection order: checkpoint combo (miss) → unet combo (hit) → the
      // two sidecar folders → queue → poll → download.
      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/object_info/CheckpointLoaderSimple",
        "/object_info/UNETLoader",
        "/models/text_encoders",
        "/models/vae",
        "/prompt",
        "/history/pid-d1",
        "/view",
      ]);
      const graph = sentJson(calls[4]!).prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
      expect(graph["11"]!.inputs.unet_name).toBe(MUSE);
      expect(graph["12"]!.inputs.clip_name).toBe("qwen3vl_4b_fp8_scaled.safetensors");
      expect(graph["12"]!.inputs.type).toBe("krea2");
      expect(graph["13"]!.inputs.vae_name).toBe("qwen_image_vae.safetensors");
      expect(result.images).toHaveLength(1);
      expect(result.seed).toBe(7);
      expect(result.resolvedTemplate).toBe("krea2-dit");
    });

    it("short-circuits on a checkpoint hit: one detection call, no sidecar fetches", async () => {
      const { transport, calls } = happyTransport("pid-d2");
      const backend = backendWith(transport);
      const result = await backend.generate({ prompt: "p", model: "graycolor_v18.safetensors" });
      const paths = calls.map((call) => new URL(call.url).pathname);
      expect(paths).toEqual([
        "/object_info/CheckpointLoaderSimple",
        "/prompt",
        "/history/pid-d2",
        "/view",
      ]);
      expect(result.resolvedTemplate).toBe("checkpoint");
    });

    it("fails closed naming the model when it is in neither loader folder", async () => {
      const { transport, calls } = ditTransport("pid-d3");
      const backend = backendWith(transport);
      let caught: unknown;
      try {
        await backend.generate({ prompt: "p", model: "ghost.safetensors" });
      } catch (error) {
        caught = error;
      }
      expect(caught instanceof ComfyImageGenConfigError).toBe(true);
      expect((caught as Error).message).toContain("ghost.safetensors");
      expect(calls.some((call) => call.url.includes("/prompt"))).toBe(false);
    });

    it("rides explicit encoder/VAE values verbatim — no folder fetch at all", async () => {
      const { transport, calls } = ditTransport("pid-d4");
      const backend = backendWith(transport);
      const result = await backend.generate({
        prompt: "p",
        model: MUSE,
        encoderName: "my_encoder.sft",
        vaeName: "my_vae.safetensors",
      });
      const graph = sentJson(calls[2]!).prompt as Record<string, { inputs: Record<string, unknown> }>;
      expect(graph["12"]!.inputs.clip_name).toBe("my_encoder.sft");
      expect(graph["13"]!.inputs.vae_name).toBe("my_vae.safetensors");
      expect(result.resolvedTemplate).toBe("krea2-dit");
      const paths = calls.map((call) => new URL(call.url).pathname);
      expect(paths.includes("/models/text_encoders")).toBe(false);
      expect(paths.includes("/models/vae")).toBe(false);
    });

    it("resolves the canonical sidecar basename across extensions and subfolders", async () => {
      const { transport, calls } = ditTransport("pid-d5", {
        encoders: ["t5xxl_fp16.safetensors", "sub/qwen3vl_4b_fp8_scaled.sft"],
        vaes: ["qwen_image_vae.safetensors"],
      });
      const backend = backendWith(transport);
      await backend.generate({ prompt: "p", model: MUSE });
      const graph = sentJson(calls[4]!).prompt as Record<string, { inputs: Record<string, unknown> }>;
      expect(graph["12"]!.inputs.clip_name).toBe("sub/qwen3vl_4b_fp8_scaled.sft");
      expect(graph["13"]!.inputs.vae_name).toBe("qwen_image_vae.safetensors");
    });

    it("falls back to a folder's single entry when no canonical match exists", async () => {
      const { transport, calls } = ditTransport("pid-d6", {
        encoders: ["only_encoder.safetensors"],
        vaes: ["only_vae.safetensors"],
      });
      const backend = backendWith(transport);
      await backend.generate({ prompt: "p", model: MUSE });
      const graph = sentJson(calls[4]!).prompt as Record<string, { inputs: Record<string, unknown> }>;
      expect(graph["12"]!.inputs.clip_name).toBe("only_encoder.safetensors");
      expect(graph["13"]!.inputs.vae_name).toBe("only_vae.safetensors");
    });

    it("fails closed listing the candidates when several non-canonical files exist", async () => {
      const { transport, calls } = ditTransport("pid-d7", {
        encoders: ["a_enc.safetensors", "b_enc.safetensors"],
      });
      const backend = backendWith(transport);
      let caught: unknown;
      try {
        await backend.generate({ prompt: "p", model: MUSE });
      } catch (error) {
        caught = error;
      }
      expect(caught instanceof ComfyImageGenConfigError).toBe(true);
      expect((caught as Error).message).toContain("qwen3vl_4b_fp8_scaled");
      expect((caught as Error).message).toContain("a_enc.safetensors");
      expect(calls.some((call) => call.url.includes("/prompt"))).toBe(false);
    });
  });

  describe("listModels (union, CG-A3)", () => {
    /** Scratch roots for the sidecar-ladder tests — removed after the
     *  suite (computed under the system tmpdir, never a literal). */
    const scratchRoots: string[] = [];
    afterAll(() => {
      for (const root of scratchRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
      }
    });
    function makeScratchRoot(): string {
      const root = mkdtempSync(join(tmpdir(), "vt-comfy-family-"));
      scratchRoots.push(root);
      return root;
    }

    /** A listModels transport serving the two folder lists, per-file
     *  embedded metadata, and the internal folder map (null = degraded,
     *  a 404 like on a hardened remote). */
    function modelsTransport(options: {
      checkpoints?: string[];
      unets?: string[];
      embedded?: (name: string) => Record<string, unknown> | undefined;
      folderPaths?: Record<string, string[]> | null;
    }) {
      return makeTransport((url) => {
        if (url.pathname === "/models/checkpoints") return Response.json(options.checkpoints ?? []);
        if (url.pathname === "/models/diffusion_models") return Response.json(options.unets ?? []);
        if (url.pathname.startsWith("/view_metadata/")) {
          const payload = options.embedded?.(url.searchParams.get("filename") ?? "");
          return Response.json(payload ?? {});
        }
        if (url.pathname === "/internal/folder_paths") {
          return options.folderPaths === null
            ? new Response("nope", { status: 404 })
            : Response.json(options.folderPaths ?? {});
        }
        return new Response("not found", { status: 404 });
      });
    }

    it("serves the checkpoints ∪ diffusion-models union — ids verbatim, labels basename, template markers", async () => {
      const { transport } = modelsTransport({
        checkpoints: ["graycolor_v18.safetensors", "illustrious\\xl-mix_v3.safetensors"],
        unets: ["museByStableYogi_v35Int8Extended.safetensors"],
        folderPaths: null,
      });
      const models = await backendWith(transport).listModels();
      expect(models).toEqual([
        { id: "graycolor_v18.safetensors", label: "graycolor_v18", template: COMFY_MODEL_TEMPLATES.checkpoint },
        { id: "illustrious\\xl-mix_v3.safetensors", label: "xl-mix_v3", template: COMFY_MODEL_TEMPLATES.checkpoint },
        {
          id: "museByStableYogi_v35Int8Extended.safetensors",
          label: "museByStableYogi_v35Int8Extended",
          template: COMFY_MODEL_TEMPLATES.krea2Dit,
        },
      ]);
    });

    it("embedded safetensors metadata is the primary family source (trainer truth beats sidecars)", async () => {
      const { transport } = modelsTransport({
        checkpoints: ["a.safetensors"],
        embedded: (name) =>
          name === "a.safetensors" ? { ss_base_model_version: "pony_diffusion_v6_xl" } : undefined,
        // A degraded folder map proves the embedded hit needs no sidecars.
        folderPaths: null,
      });
      const models = await backendWith(transport).listModels();
      expect(models[0]!.family).toBe("Pony");
    });

    it("embedded modelspec.architecture resolves too (AI-Toolkit DiT convention)", async () => {
      const { transport } = modelsTransport({
        unets: ["muse.safetensors"],
        embedded: (name) => (name === "muse.safetensors" ? { "modelspec.architecture": "krea2" } : undefined),
        folderPaths: null,
      });
      const models = await backendWith(transport).listModels();
      expect(models[0]!.family).toBe("Krea 2");
    });

    it("the .cm-info.json sidecar serves when embedded misses (Stability Matrix store)", async () => {
      const root = makeScratchRoot();
      writeFileSync(join(root, "a.cm-info.json"), JSON.stringify({ BaseModel: "Illustrious" }));
      const { transport } = modelsTransport({
        checkpoints: ["a.safetensors"],
        folderPaths: { checkpoints: [root] },
      });
      const models = await backendWith(transport).listModels();
      expect(models[0]!.family).toBe("Illustrious");
    });

    it("the .civitai.info sidecar is the third store (civitai download flow)", async () => {
      const root = makeScratchRoot();
      writeFileSync(join(root, "a.civitai.info"), JSON.stringify({ baseModel: "Flux.1 D" }));
      const { transport } = modelsTransport({
        checkpoints: ["a.safetensors"],
        folderPaths: { checkpoints: [root] },
      });
      const models = await backendWith(transport).listModels();
      expect(models[0]!.family).toBe("Flux");
    });

    it("subfolder ids join their sidecar inside the subdirectory", async () => {
      const root = makeScratchRoot();
      mkdirSync(join(root, "illustrious"));
      writeFileSync(
        join(root, "illustrious", "xl-mix_v3.cm-info.json"),
        JSON.stringify({ BaseModel: "Illustrious" }),
      );
      const { transport } = modelsTransport({
        checkpoints: ["illustrious\\xl-mix_v3.safetensors"],
        folderPaths: { checkpoints: [root] },
      });
      const models = await backendWith(transport).listModels();
      expect(models[0]!.family).toBe("Illustrious");
    });

    it("an unrecognized raw family passes through verbatim (honest bucket, never a guess)", async () => {
      const root = makeScratchRoot();
      writeFileSync(join(root, "a.cm-info.json"), JSON.stringify({ BaseModel: "Weird New Base" }));
      const { transport } = modelsTransport({
        checkpoints: ["a.safetensors"],
        folderPaths: { checkpoints: [root] },
      });
      const models = await backendWith(transport).listModels();
      expect(models[0]!.family).toBe("Weird New Base");
    });

    it("every store missing → no family key, list still succeeds", async () => {
      const { transport } = modelsTransport({
        checkpoints: ["a.safetensors"],
        unets: ["m.safetensors"],
        folderPaths: null,
      });
      const models = await backendWith(transport).listModels();
      expect(models).toHaveLength(2);
      for (const model of models) {
        expect("family" in model).toBe(false);
      }
    });

    it("skips malformed entries and maps upstream failures of BOTH folder lists", async () => {
      const { transport } = modelsTransport({
        checkpoints: ["ok.safetensors", 42, "", null],
        unets: [],
        folderPaths: null,
      });
      expect(await backendWith(transport).listModels()).toEqual([
        { id: "ok.safetensors", label: "ok", template: COMFY_MODEL_TEMPLATES.checkpoint },
      ]);

      const checkpointsDown = makeTransport((url) =>
        url.pathname === "/models/checkpoints" ? new Response("nope", { status: 500 }) : Response.json([]),
      );
      let caught: unknown;
      try {
        await backendWith(checkpointsDown.transport).listModels();
      } catch (error) {
        caught = error;
      }
      expect(caught instanceof ComfyImageGenError).toBe(true);
      expect((caught as ComfyImageGenError).status).toBe(500);

      const unetsDown = makeTransport((url) =>
        url.pathname === "/models/diffusion_models" ? new Response("nope", { status: 502 }) : Response.json([]),
      );
      let caughtUnets: unknown;
      try {
        await backendWith(unetsDown.transport).listModels();
      } catch (error) {
        caughtUnets = error;
      }
      expect(caughtUnets instanceof ComfyImageGenError).toBe(true);
      expect((caughtUnets as ComfyImageGenError).status).toBe(502);
    });
  });

  describe("normalizeComfyFamily (CG-A3)", () => {
    it("maps recognized ecosystem buckets and passes unknown values through", () => {
      expect(normalizeComfyFamily("Pony Diffusion V6 XL")).toBe("Pony");
      expect(normalizeComfyFamily("pony_diffusion_v6_xl")).toBe("Pony");
      expect(normalizeComfyFamily("Illustrious")).toBe("Illustrious");
      expect(normalizeComfyFamily("NoobAI XL v1")).toBe("Illustrious");
      expect(normalizeComfyFamily("Krea 2")).toBe("Krea 2");
      expect(normalizeComfyFamily("qwen-image")).toBe("Qwen Image");
      expect(normalizeComfyFamily("Flux.1 D")).toBe("Flux");
      expect(normalizeComfyFamily("SDXL 1.0")).toBe("SDXL");
      expect(normalizeComfyFamily("sd_xl_base")).toBe("SDXL");
      expect(normalizeComfyFamily("stable-diffusion-xl-v1-base")).toBe("SDXL");
      expect(normalizeComfyFamily("SD 1.5")).toBe("SD 1.5");
      expect(normalizeComfyFamily("stable-diffusion-v1-5")).toBe("SD 1.5");
      expect(normalizeComfyFamily("  Some New Base  ")).toBe("Some New Base");
      expect(normalizeComfyFamily(undefined)).toBeUndefined();
      expect(normalizeComfyFamily("   ")).toBeUndefined();
    });
  });

  describe("listSamplers & listSchedulers (CG-A3)", () => {
    it("maps the KSampler combo enums to bare entries", async () => {
      const { transport } = makeTransport((url) => {
        if (url.pathname === "/object_info/KSampler") {
          return Response.json({
            KSampler: {
              input: {
                required: {
                  sampler_name: [["euler", "dpmpp_2m_sde"], {}],
                  scheduler: [["simple", "beta"], {}],
                },
              },
            },
          });
        }
        return new Response("not found", { status: 404 });
      });
      const backend = backendWith(transport);
      expect(backend.listSamplers).toBeDefined();
      expect(await backend.listSamplers!()).toEqual([{ name: "euler" }, { name: "dpmpp_2m_sde" }]);
      expect(await backend.listSchedulers!()).toEqual([{ name: "simple" }, { name: "beta" }]);
    });

    it("maps upstream failures with the upstream status", async () => {
      const { transport } = makeTransport(() => new Response("nope", { status: 503 }));
      const backend = backendWith(transport);
      let caught: unknown;
      try {
        await backend.listSamplers!();
      } catch (error) {
        caught = error;
      }
      expect(caught instanceof ComfyImageGenError).toBe(true);
      expect((caught as ComfyImageGenError).status).toBe(503);
    });
  });

  describe("listDitSidecars (CG-B1)", () => {
    it("returns both live folder catalogs (verbatim ids, parallel fetch)", async () => {
      const { transport, calls } = ditTransport("p1", {
        encoders: ["qwen3vl_4b_fp8_scaled.safetensors", "folder/t5xxl_fp16.safetensors"],
        vaes: ["qwen_image_vae.safetensors"],
      });
      const sidecars = await backendWith(transport).listDitSidecars!();
      expect(sidecars).toEqual({
        encoders: ["qwen3vl_4b_fp8_scaled.safetensors", "folder/t5xxl_fp16.safetensors"],
        vaes: ["qwen_image_vae.safetensors"],
      });
      // Exactly the two folder fetches — no /prompt, no side-effect calls.
      const paths = calls.map((c) => new URL(c.url).pathname);
      expect(paths).toEqual(["/models/text_encoders", "/models/vae"]);
    });

    it("fails closed when a folder list errors (non-array shapes throw)", async () => {
      const { transport } = makeTransport((url) => {
        if (url.pathname === "/models/text_encoders") return Response.json({ not: "an array" });
        if (url.pathname === "/models/vae") return Response.json(["qwen_image_vae.safetensors"]);
        return new Response("not found", { status: 404 });
      });
      let caught: unknown;
      try {
        await backendWith(transport).listDitSidecars!();
      } catch (error) {
        caught = error;
      }
      expect(caught instanceof ComfyImageGenError).toBe(true);
      expect((caught as ComfyImageGenError).message).toContain("unexpected shape");
    });

    it("carries the upstream status on folder-list HTTP failures", async () => {
      const { transport } = makeTransport(() => new Response("boom", { status: 500 }));
      let caught: unknown;
      try {
        await backendWith(transport).listDitSidecars!();
      } catch (error) {
        caught = error;
      }
      expect(caught instanceof ComfyImageGenError).toBe(true);
      expect((caught as ComfyImageGenError).status).toBe(500);
    });
  });

  describe("listLoras (family ladder, CG-C2)", () => {
    /** Scratch roots for the sidecar-ladder cases — removed after the
     *  suite (computed under the system tmpdir, never a literal). */
    const scratchRoots: string[] = [];
    afterAll(() => {
      for (const root of scratchRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
      }
    });
    function makeScratchRoot(): string {
      const root = mkdtempSync(join(tmpdir(), "vt-comfy-lora-"));
      scratchRoots.push(root);
      return root;
    }

    /** A listLoras transport serving the LoraLoader combo, per-file
     *  embedded metadata, and the internal folder map (null = degraded,
     *  a 404 like on a hardened remote). */
    function lorasTransport(options: {
      loras?: string[];
      embedded?: (name: string) => Record<string, unknown> | undefined;
      folderPaths?: Record<string, string[]> | null;
    }) {
      return makeTransport((url) => {
        if (url.pathname === "/object_info/LoraLoader") {
          return objectInfoResponse("LoraLoader", "lora_name", options.loras ?? []);
        }
        if (url.pathname.startsWith("/view_metadata/")) {
          const payload = options.embedded?.(url.searchParams.get("filename") ?? "");
          return Response.json(payload ?? {});
        }
        if (url.pathname === "/internal/folder_paths") {
          return options.folderPaths === null
            ? new Response("nope", { status: 404 })
            : Response.json(options.folderPaths ?? {});
        }
        return new Response("not found", { status: 404 });
      });
    }

    it("serves the LoraLoader combo verbatim with family from the SAME ladder as models", async () => {
      const { transport } = lorasTransport({
        loras: ["nijireol_krea2_v1_ep5.safetensors", "arden_il_v2.safetensors"],
        embedded: (name) =>
          name === "nijireol_krea2_v1_ep5.safetensors" ? { ss_base_model_version: "krea2" } : undefined,
        folderPaths: null,
      });
      const loras = await backendWith(transport).listLoras!();
      expect(loras).toEqual([
        { name: "nijireol_krea2_v1_ep5.safetensors", family: "Krea 2", triggerWords: [] },
        { name: "arden_il_v2.safetensors", family: null, triggerWords: [] },
      ]);  // embedded hit + the honest null bucket, zero sidecar calls
    });

    it("the .cm-info.json sidecar serves when embedded misses (the owner's manual SM store)", async () => {
      const root = makeScratchRoot();
      writeFileSync(join(root, "arden_il_v2.cm-info.json"), JSON.stringify({ BaseModel: "Illustrious" }));
      const { transport } = lorasTransport({
        loras: ["arden_il_v2.safetensors"],
        folderPaths: { loras: [root] },
      });
      const loras = await backendWith(transport).listLoras!();
      expect(loras).toEqual([{ name: "arden_il_v2.safetensors", family: "Illustrious", triggerWords: [] }]);
    });

    it("the .civitai.info sidecar is the third store (subfolder ids join inside)", async () => {
      const root = makeScratchRoot();
      mkdirSync(join(root, "krea"));
      writeFileSync(join(root, "krea", "nijireol_v1.civitai.info"), JSON.stringify({ baseModel: "Krea 2" }));
      const { transport } = lorasTransport({
        loras: ["krea\\nijireol_v1.safetensors"],
        folderPaths: { loras: [root] },
      });
      const loras = await backendWith(transport).listLoras!();
      expect(loras).toEqual([{ name: "krea\\nijireol_v1.safetensors", family: "Krea 2", triggerWords: [] }]);
    });

    it("a ladder miss lands in the null bucket — never a guessed family", async () => {
      const { transport } = lorasTransport({ loras: ["stripped_lora.safetensors"], folderPaths: null });
      const loras = await backendWith(transport).listLoras!();
      expect(loras).toEqual([{ name: "stripped_lora.safetensors", family: null, triggerWords: [] }]);
    });

    it("LEARNS trigger words from the SM store (TrainedWords — the owner-directed pull-forward)", async () => {
      const root = makeScratchRoot();
      writeFileSync(
        join(root, "nijireol_krea2_v1_ep5.cm-info.json"),
        JSON.stringify({ BaseModel: "Krea 2", TrainedWords: ["Nijireol"] }),
      );
      const { transport } = lorasTransport({
        loras: ["nijireol_krea2_v1_ep5.safetensors"],
        embedded: () => ({ ss_base_model_version: "krea2" }),
        folderPaths: { loras: [root] },
      });
      const loras = await backendWith(transport).listLoras!();
      expect(loras).toEqual([
        { name: "nijireol_krea2_v1_ep5.safetensors", family: "Krea 2", triggerWords: ["Nijireol"] },
      ]);
    });

    it("trigger words fall through to the civitai store when SM carries null, comma-phrases kept VERBATIM", async () => {
      const root = makeScratchRoot();
      writeFileSync(join(root, "hisoka.cm-info.json"), JSON.stringify({ BaseModel: "Illustrious", TrainedWords: null }));
      writeFileSync(
        join(root, "hisoka.civitai.info"),
        JSON.stringify({ baseModel: "Illustrious", trainedWords: ["hisoka_morow, red hair, yellow eyes"] }),
      );
      const { transport } = lorasTransport({
        loras: ["hisoka.safetensors"],
        folderPaths: { loras: [root] },
      });
      const loras = await backendWith(transport).listLoras!();
      expect(loras[0]!.triggerWords).toEqual(["hisoka_morow, red hair, yellow eyes"]);
    });

    it("all-empty TrainedWords arrays degrade to the next store, then to none", async () => {
      const root = makeScratchRoot();
      writeFileSync(join(root, "blank.cm-info.json"), JSON.stringify({ BaseModel: "Pony", TrainedWords: ["", "   "] }));
      writeFileSync(join(root, "blank.civitai.info"), JSON.stringify({ baseModel: "Pony", trainedWords: [] }));
      const { transport } = lorasTransport({
        loras: ["blank.safetensors"],
        folderPaths: { loras: [root] },
      });
      const loras = await backendWith(transport).listLoras!();
      expect(loras[0]).toEqual({ name: "blank.safetensors", family: "Pony", triggerWords: [] });
    });

    it("carries the upstream status on combo HTTP failures", async () => {
      const { transport } = makeTransport(() => new Response("boom", { status: 503 }));
      let caught: unknown;
      try {
        await backendWith(transport).listLoras!();
      } catch (error) {
        caught = error;
      }
      expect(caught instanceof ComfyImageGenError).toBe(true);
      expect((caught as ComfyImageGenError).status).toBe(503);
    });
  });

  describe("probe", () => {
    it("probes /system_stats and reports the ComfyUI version", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({ system: { comfyui_version: "0.3.66", python_version: "3.12" }, devices: [] }),
      );
      const backend = backendWith(transport);
      const result = await backend.probe();
      expect(result.ok).toBe(true);
      expect(result.detail).toBe("ComfyUI 0.3.66");
      expect(calls[0]!.url).toBe(`${ENDPOINT}/system_stats`);
    });

    it("degrades to a plain detail when the version is missing, and reports failures as data", async () => {
      const { transport } = makeTransport(() => Response.json({ system: {}, devices: [] }));
      expect(await backendWith(transport).probe()).toEqual({ ok: true, detail: "ComfyUI server" });

      const failing = makeTransport(() => new Response("down", { status: 503 }));
      const result = await backendWith(failing.transport).probe();
      expect(result.ok).toBe(false);
      expect(result.status).toBe(503);

      const refused = makeTransport(() => {
        throw new Error("Connection refused");
      });
      const offline = await backendWith(refused.transport).probe();
      expect(offline.ok).toBe(false);
      expect(offline.detail).toContain("Connection refused");
    });
  });

  describe("config", () => {
    it("requires an endpoint", () => {
      expect(() => comfyImageGenFactory({ endpoint: "  " })).toThrow(ComfyImageGenConfigError);
    });

    it("rejects an API key — ComfyUI core has no auth (fail closed, no invented header)", () => {
      expect(() => comfyImageGenFactory({ endpoint: ENDPOINT, apiKey: "sk-whatever" })).toThrow(
        ComfyImageGenConfigError,
      );
    });
  });
});

describe("comfyui ws progress + interrupt (CG-C1)", () => {
  /** A fake run-scoped socket — records closes, lets the test push server
   *  frames (text JSON / raw / binary) at deterministic points of the run
   *  (from inside the transport handlers). Satisfies the
   *  ImageGenWebSocketLike seam without a DOM. */
  function makeFakeWs() {
    let onMessage: ((event: { data: unknown }) => void) | null = null;
    let onClose: ((event: unknown) => void) | null = null;
    let onError: ((event: unknown) => void) | null = null;
    const socket = {
      get onmessage() {
        return onMessage;
      },
      set onmessage(listener: ((event: { data: unknown }) => void) | null) {
        onMessage = listener;
      },
      get onclose() {
        return onClose;
      },
      set onclose(listener: ((event: unknown) => void) | null) {
        onClose = listener;
      },
      get onerror() {
        return onError;
      },
      set onerror(listener: ((event: unknown) => void) | null) {
        onError = listener;
      },
      close() {
        closes.push(1);
      },
    };
    const closes: number[] = [];
    return {
      socket,
      closes,
      pushText(payload: unknown) {
        if (onMessage !== null) onMessage({ data: JSON.stringify(payload) });
      },
      pushRaw(raw: string) {
        if (onMessage !== null) onMessage({ data: raw });
      },
      pushBinary() {
        if (onMessage !== null) onMessage({ data: new ArrayBuffer(8) });
      },
    };
  }

  /** Unique endpoint per test: the run-snapshot registry is module-level
   *  and keyed by endpoint — distinct ports keep the tests isolated. */
  const WS_EP = (port: number) => `http://127.0.0.1:${port}`;

  it("generate opens the ws listener with the queue's clientId, maps step events to the poll snapshot, and closes the socket at run end", async () => {
    const PID = "ws-pid-1";
    const fake = makeFakeWs();
    const wsUrls: string[] = [];
    let backend: ReturnType<typeof comfyImageGenFactory> | undefined;
    let midRun: { progress: number; state?: string } | null = null;
    let polls = 0;
    const { transport, calls } = makeTransport(async (url) => {
      if (url.pathname === "/object_info/CheckpointLoaderSimple") {
        return objectInfoResponse("CheckpointLoaderSimple", "ckpt_name", HAPPY_CHECKPOINTS);
      }
      if (url.pathname === "/prompt") return queuedOk(PID);
      if (url.pathname === `/history/${PID}`) {
        polls += 1;
        if (polls === 1) {
          fake.pushText({ type: "progress", data: { value: 2, max: 8, prompt_id: PID, node: "3" } });
          midRun = await backend!.progress();
          fake.pushText({ type: "progress", data: { value: 7, max: 8, prompt_id: PID, node: "3" } });
          return Response.json({});
        }
        fake.pushText({ type: "executing", data: { node: null, prompt_id: PID } });
        return historyDone(PID);
      }
      if (url.pathname === "/view") return new Response(new Uint8Array(PNG_BYTES));
      return new Response("not found", { status: 404 });
    });
    backend = comfyImageGenFactory({
      endpoint: WS_EP(9101),
      fetch: transport,
      openWebSocket: (url) => {
        wsUrls.push(url);
        return fake.socket;
      },
    });

    const result = await backend.generate({ prompt: "a tavern", model: "graycolor_v18.safetensors" });
    expect(result.images.length).toBe(1);
    // The socket opened exactly once, BEFORE the queue POST, on the ws
    // scheme, with the SAME client id the /prompt payload carries.
    expect(wsUrls.length).toBe(1);
    const queueCall = calls.find((c) => new URL(c.url).pathname === "/prompt");
    expect(queueCall).toBeTruthy();
    const queueBody = sentJson(queueCall!);
    expect(typeof queueBody.client_id).toBe("string");
    expect(wsUrls[0]).toBe(`ws://127.0.0.1:9101/ws?clientId=${queueBody.client_id}`);
    // Mid-run poll: 2/8 mapped to the 0..1 fraction + the step state.
    expect(midRun).toEqual({ progress: 0.25, state: "step 2/8" });
    // After the run: the terminal event (executing node=null) → 100%.
    expect(await backend.progress()).toEqual({ progress: 1 });
    // The listener closed with the run (the finally arm).
    expect(fake.closes.length).toBe(1);
  });

  it("events that arrive BEFORE the queue response (pre-bind) are buffered and replayed once the prompt id is known", async () => {
    const PID = "ws-pid-2";
    const fake = makeFakeWs();
    let backend: ReturnType<typeof comfyImageGenFactory> | undefined;
    let replayed: { progress: number; state?: string } | null = null;
    let polls = 0;
    const { transport } = makeTransport(async (url) => {
      if (url.pathname === "/object_info/CheckpointLoaderSimple") {
        return objectInfoResponse("CheckpointLoaderSimple", "ckpt_name", HAPPY_CHECKPOINTS);
      }
      if (url.pathname === "/prompt") {
        // Pushed while the queue POST is still being served — the prompt id
        // is NOT bound yet, so this frame must land in the buffer.
        fake.pushText({ type: "progress", data: { value: 3, max: 8, prompt_id: PID, node: "3" } });
        return queuedOk(PID);
      }
      if (url.pathname === `/history/${PID}`) {
        polls += 1;
        if (polls === 1) {
          replayed = await backend!.progress();
          return Response.json({});
        }
        return historyDone(PID);
      }
      if (url.pathname === "/view") return new Response(new Uint8Array(PNG_BYTES));
      return new Response("not found", { status: 404 });
    });
    backend = comfyImageGenFactory({
      endpoint: WS_EP(9102),
      fetch: transport,
      openWebSocket: () => fake.socket,
    });

    await backend.generate({ prompt: "a tavern", model: "graycolor_v18.safetensors" });
    expect(replayed).toEqual({ progress: 0.375, state: "step 3/8" });
  });

  it("cross-prompt events, binary preview frames, and malformed text frames are all ignored", async () => {
    const PID = "ws-pid-3";
    const fake = makeFakeWs();
    let polls = 0;
    const { transport } = makeTransport(async (url) => {
      if (url.pathname === "/object_info/CheckpointLoaderSimple") {
        return objectInfoResponse("CheckpointLoaderSimple", "ckpt_name", HAPPY_CHECKPOINTS);
      }
      if (url.pathname === "/prompt") return queuedOk(PID);
      if (url.pathname === `/history/${PID}`) {
        polls += 1;
        if (polls === 1) {
          // Another client's prompt — ComfyUI broadcasts to every socket.
          fake.pushText({ type: "progress", data: { value: 99, max: 100, prompt_id: "someone-else" } });
          // The live latent preview binary frame (ignored in v1).
          fake.pushBinary();
          // A malformed text frame.
          fake.pushRaw("{not json");
          fake.pushText({ type: "progress", data: { value: 4, max: 8, prompt_id: PID, node: "3" } });
          return Response.json({});
        }
        return historyDone(PID);
      }
      if (url.pathname === "/view") return new Response(new Uint8Array(PNG_BYTES));
      return new Response("not found", { status: 404 });
    });
    const backend = comfyImageGenFactory({
      endpoint: WS_EP(9103),
      fetch: transport,
      openWebSocket: () => fake.socket,
    });

    await backend.generate({ prompt: "a tavern", model: "graycolor_v18.safetensors" });
    // Only OUR 4/8 event landed (0.5); the noise never threw and never
    // wrote a snapshot.
    expect(await backend.progress()).toEqual({ progress: 1 });
  });

  it("an unopenable socket degrades SILENTLY — the generation still completes", async () => {
    const PID = "ws-pid-4";
    const { transport } = happyTransport(PID);
    const backend = comfyImageGenFactory({
      endpoint: WS_EP(9104),
      fetch: transport,
      openWebSocket: () => {
        throw new Error("connect ECONNREFUSED");
      },
    });

    const result = await backend.generate({ prompt: "a tavern", model: "graycolor_v18.safetensors" });
    expect(result.images.length).toBe(1);
    // History completion stamped the bar's 100% anyway.
    expect(await backend.progress()).toEqual({ progress: 1 });
  });

  it("progress() on an idle endpoint reports an honest zero (never a fake cloud bar)", async () => {
    const backend = comfyImageGenFactory({ endpoint: WS_EP(9105), fetch: happyTransport("unused").transport });
    expect(await backend.progress()).toEqual({ progress: 0 });
  });

  it("interrupt POSTs /interrupt and maps a failure to the upstream status", async () => {
    const { transport, calls } = makeTransport((url) => {
      if (url.pathname === "/interrupt") return new Response(null, { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const backend = comfyImageGenFactory({ endpoint: WS_EP(9106), fetch: transport });
    await backend.interrupt();
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(`${WS_EP(9106)}/interrupt`);
    expect(calls[0]!.init?.method).toBe("POST");

    const { transport: failing } = makeTransport((url) => {
      if (url.pathname === "/interrupt") return new Response("boom", { status: 500 });
      return new Response("not found", { status: 404 });
    });
    const failingBackend = comfyImageGenFactory({ endpoint: WS_EP(9107), fetch: failing });
    let caught: unknown;
    try {
      await failingBackend.interrupt();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ComfyImageGenError);
    expect((caught as ComfyImageGenError).status).toBe(500);
  });
});

describe("comfyui registry registration", () => {
  it("registers under the roster slug (import side effect)", async () => {
    // Importing the adapter module registers the factory — create through
    // the registry to prove the slug resolves (the a1111 twin's check).
    const { createImageGenBackend } = await import("../src/domain/imagegen/imagegen-registry.js");
    const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.ComfyUI, {
      endpoint: ENDPOINT,
      fetch: (() => new Response()) as unknown as typeof fetch,
    });
    expect(typeof backend.generate).toBe("function");
  });
});
