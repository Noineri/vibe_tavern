/**
 * Unit tests for the ComfyUI image-gen adapter (COMFYUI_BACKEND_PLAN CG-A1)
 * — mocked transport at the config-injected fetch seam (tier T1: the double
 * is a function argument, no mock.module, no globalThis patches). Every
 * pinned request/response shape traces to the live-verified research card
 * (reports/IMAGEGEN_POLISH_REPORT.md § PG-5, ComfyUI 0.36.0, 2026-09-18):
 * POST /prompt → {prompt_id, node_errors}, GET /history/{id} →
 * {[id]: {outputs, status}}, GET /view → bytes.
 */

import { describe, expect, it } from "bun:test";
import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import {
  COMFY_HISTORY_POLL_INTERVAL_MS,
  COMFY_NODE_DEFAULTS,
  ComfyImageGenConfigError,
  ComfyImageGenError,
  ComfyImageGenSizeError,
  buildComfyCheckpointWorkflow,
  comfyImageGenFactory,
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

/** A full happy-path transport: /prompt → /history (pending then done) →
 *  /view (PNG bytes). URL-dispatched so the three calls stay distinct. */
function happyTransport(promptId: string, pendingPolls = 0) {
  let polls = 0;
  return makeTransport((url) => {
    if (url.pathname === "/prompt") return queuedOk(promptId);
    if (url.pathname === `/history/${promptId}`) {
      polls += 1;
      return polls <= pendingPolls ? Response.json({}) : historyDone(promptId);
    }
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

      // POST /prompt body: the workflow graph + a client id.
      expect(calls[0]!.url).toBe(`${ENDPOINT}/prompt`);
      const queued = sentJson(calls[0]!);
      expect(queued.client_id).toMatch(/^[\da-f-]{36}$/);
      const graph = queued.prompt as Record<string, { class_type: string }>;
      expect(graph["4"]!.class_type).toBe("CheckpointLoaderSimple");
      // History poll targets the queued prompt id.
      expect(calls[1]!.url).toBe(`${ENDPOINT}/history/pid-1`);
      // /view carries the row's fields as query params.
      const view = new URL(calls[2]!.url);
      expect(view.pathname).toBe("/view");
      expect(view.searchParams.get("filename")).toBe("vt_imagegen_00001_.png");
      expect(view.searchParams.get("subfolder")).toBe("");
      expect(view.searchParams.get("type")).toBe("output");
      // Result: downloaded bytes + sniffed MIME + resolved seed + W/H echo.
      expect(result.images).toHaveLength(1);
      expect(result.images[0]!.mimeType).toBe("image/png");
      expect(result.images[0]!.data.equals(PNG_BYTES)).toBe(true);
      expect(result.seed).toBe(42);
      expect(result.width).toBe(512);
      expect(result.height).toBe(512);
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
      const { transport } = makeTransport(() =>
        Response.json({
          prompt_id: "pid-3",
          number: 1,
          node_errors: { "4": { errors: [{ type: "value_not_in_list" }] } },
        }),
      );
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

    it("maps a non-2xx /prompt to the upstream status", async () => {
      const { transport } = makeTransport(() => new Response("boom", { status: 500 }));
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
      expect(calls[0]!.url).toBe(`${ENDPOINT}/prompt`);
    });
  });

  describe("listModels", () => {
    it("maps the checkpoint filename list — id verbatim (round-trips into ckpt_name), label basename", async () => {
      const { transport } = makeTransport(() =>
        Response.json(["graycolor_v18.safetensors", "illustrious\\xl-mix_v3.safetensors", "merge/soft.safetensors"]),
      );
      const backend = backendWith(transport);
      const models = await backend.listModels();
      expect(models).toEqual([
        { id: "graycolor_v18.safetensors", label: "graycolor_v18" },
        { id: "illustrious\\xl-mix_v3.safetensors", label: "xl-mix_v3" },
        { id: "merge/soft.safetensors", label: "soft" },
      ]);
    });

    it("skips malformed entries and maps upstream failures", async () => {
      const { transport } = makeTransport(() =>
        Response.json(["ok.safetensors", 42, "", null]),
      );
      const backend = backendWith(transport);
      expect(await backend.listModels()).toEqual([{ id: "ok.safetensors", label: "ok" }]);

      const failing = makeTransport(() => new Response("nope", { status: 500 }));
      let caught: unknown;
      try {
        await backendWith(failing.transport).listModels();
      } catch (error) {
        caught = error;
      }
      expect(caught instanceof ComfyImageGenError).toBe(true);
      expect((caught as ComfyImageGenError).status).toBe(500);
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
