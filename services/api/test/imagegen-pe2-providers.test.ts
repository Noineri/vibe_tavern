/**
 * PE-2 provider backends (IMAGEGEN_PROVIDER_EXPANSION_PLAN wave 2) —
 * custom-JSON arms + the wave's OpenAI-images family rows.
 *
 * Every block pins the wire contract against the provider's card
 * (IMAGE_GEN_CLOUD_PROVIDERS_RESEARCH, doc-verified 2026-09-07, live
 * re-verified 2026-09-18) through the T1 fetch seam — no globalThis
 * patching, no mock.module (the PE-1 file's discipline).
 */

import { describe, expect, it } from "bun:test";

import { IMAGE_GEN_BACKENDS, IMAGE_GEN_BACKEND_CAPABILITIES } from "@vibe-tavern/domain";

import { ZAI_IMAGE_SIZES } from "../src/domain/imagegen/backends/openai-images-family.js";
import { MINIMAX_ASPECT_RATIOS } from "../src/domain/imagegen/backends/minimax.js";
import { pollDashScopeTask } from "../src/domain/imagegen/backends/dashscope.js";
import { createImageGenBackend } from "../src/domain/imagegen/imagegen-registry.js";

// ─── Shared helpers (the PE-1 file's, verbatim discipline) ───────────────────

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

/** T1 transport double — records every call, returns scripted responses. */
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

/** Request body of a recorded POST (JSON-parsed). */
function sentJson(call: RecordedCall): Record<string, unknown> {
  const body = call.init?.body;
  if (typeof body !== "string") throw new Error("expected a JSON string body");
  return JSON.parse(body) as Record<string, unknown>;
}

/** Build a family/arm backend through the registry (import-time side-effect
 *  registrations are the production wiring). */
function familyBackend(
  slug: (typeof IMAGE_GEN_BACKENDS)[keyof typeof IMAGE_GEN_BACKENDS],
  transport: typeof fetch,
  endpoint: string,
  apiKey: string,
): ReturnType<typeof createImageGenBackend> {
  return createImageGenBackend(slug, { endpoint, apiKey, fetch: transport });
}

/** 1x1 transparent PNG bytes. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** An OpenAI-images data[] response carrying b64_json entries. */
function b64DataResponse(images: Buffer[]): Response {
  return Response.json({ created: 0, data: images.map((bytes) => ({ b64_json: bytes.toString("base64") })) });
}

// ─── MiniMax image-01 (PE-2 unit 2) ──────────────────────────────

const MINIMAX_ENDPOINT = "https://api.minimax.io";

describe("minimax (custom-JSON arm)", () => {
  const make = (transport: typeof fetch) =>
    familyBackend(IMAGE_GEN_BACKENDS.MiniMax, transport, MINIMAX_ENDPOINT, "mm-key");

  /** A scripted two-response double: the generation POST first, then the
   *  server-side byte download. */
  function genThenBytes(genResponse: Response, bytes: Buffer = PNG_BYTES): typeof fetch {
    let answered = false;
    return (url, init) => {
      if (!answered) {
        answered = true;
        return Promise.resolve(genResponse);
      }
      return Promise.resolve(new Response(new Uint8Array(bytes), { status: 200 }));
    };
  }

  describe("generate", () => {
    it("sends the documented body: model default image-01, ratio from the pixel map, response_format base64, seed", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({
          id: "t1",
          data: { image_base64s: [PNG_BYTES.toString("base64")] },
          metadata: { success_count: 1, failed_count: 0 },
          base_resp: { status_code: 0, status_msg: "success" },
        }),
      );
      const backend = make(transport);

      const result = await backend.generate({
        prompt: "a tavern at dusk",
        width: 1344,
        height: 576, // the 21:9 pixel-map value
        seed: 424242,
      });

      expect(calls[0].url).toBe(`${MINIMAX_ENDPOINT}/v1/image_generation`);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer mm-key");
      const body = sentJson(calls[0]);
      // image-01 is the documented single-value enum — the default.
      expect(body.model).toBe("image-01");
      expect(body.prompt).toBe("a tavern at dusk");
      expect(body.aspect_ratio).toBe("21:9");
      expect(body.response_format).toBe("base64");
      expect(body.seed).toBe(424242);
      // n / prompt_optimizer have no VT seam — never sent.
      expect("n" in body).toBe(false);
      expect("prompt_optimizer" in body).toBe(false);
      // ratio form wins upstream — width/height stay OFF the wire for map hits.
      expect("width" in body).toBe(false);
      expect("height" in body).toBe(false);
      // base64 entries decode in-process.
      expect(result.images).toHaveLength(1);
      expect(result.images[0].data.equals(PNG_BYTES)).toBe(true);
      expect(result.images[0].mimeType).toBe("image/png");
    });

    it("maps user-added sizes to width+height and fails closed off-map without an entry", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({ data: { image_base64s: ["x"] }, base_resp: { status_code: 0 } }),
      );
      const backend = make(transport);
      await expect(
        backend.generate({ prompt: "p", width: 1000, height: 1000 }),
      ).rejects.toThrow(/MiniMax has no documented size for 1000x1000/);
      expect(calls).toHaveLength(0);

      // 1536x1024: [512,2048] div 8 — a user entry IS the vendor claim.
      const user = makeTransport(() =>
        Response.json({ data: { image_base64s: [PNG_BYTES.toString("base64")] }, base_resp: { status_code: 0 } }),
      );
      const userBackend = createImageGenBackend(IMAGE_GEN_BACKENDS.MiniMax, {
        endpoint: MINIMAX_ENDPOINT,
        apiKey: "mm-key",
        userSizes: [{ width: 1536, height: 1024 }],
        fetch: user.transport,
      });
      await userBackend.generate({ prompt: "p", width: 1536, height: 1024 });
      const body = sentJson(user.calls[0]);
      expect(body.width).toBe(1536);
      expect(body.height).toBe(1024);
      expect("aspect_ratio" in body).toBe(false);
    });

    it("honors the IN-BAND base_resp failure inside HTTP 200 (the live-probed 1004 login-fail shape)", async () => {
      const { transport } = makeTransport(() =>
        Response.json({
          base_resp: { status_code: 1004, status_msg: "login fail: Please carry the API secret key" },
        }),
      );
      const backend = make(transport);
      await expect(backend.generate({ prompt: "p" })).rejects.toThrow(
        /status 1004: login fail/,
      );
    });

    it("downloads https entries server-side (url-mode fallback field)", async () => {
      const { transport, calls } = makeTransport(
        () =>
          Response.json({
            data: { image_urls: ["https://files.minimax.io/img.png"] },
            base_resp: { status_code: 0 },
          }),
      );
      const backend = make(genThenBytesWrapper());
      function genThenBytesWrapper(): typeof fetch {
        let answered = false;
        return (url, init) => {
          if (!answered) {
            answered = true;
            return transport(url, init);
          }
          return Promise.resolve(new Response(new Uint8Array(PNG_BYTES), { status: 200 }));
        };
      }
      void calls;
      const result = await backend.generate({ prompt: "p" });
      expect(result.images[0].data.equals(PNG_BYTES)).toBe(true);
    });
  });

  describe("listModels + probe", () => {
    it("lists the documented OpenAI-compat catalog filtered to the image-* family", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({
          data: [{ id: "abab-chat" }, { id: "image-01" }, { id: "speech-2.8-hd" }],
          base_resp: { status_code: 0 },
        }),
      );
      const backend = make(transport);
      const models = await backend.listModels();
      expect(models).toEqual([{ id: "image-01", label: "image-01" }]);
      expect(calls[0].url).toBe(`${MINIMAX_ENDPOINT}/v1/models`);

      const probed = await backend.probe();
      expect(probed).toEqual({ ok: true, detail: "1 image models" });
    });

    it("probe honors an in-band auth failure inside HTTP 200", async () => {
      const { transport } = makeTransport(() =>
        Response.json({ base_resp: { status_code: 1004, status_msg: "login fail" } }),
      );
      const backend = make(transport);
      const probed = await backend.probe();
      expect(probed.ok).toBe(false);
      expect(probed.detail).toContain("1004");
    });
  });

  describe("capability row + registry", () => {
    it("pins the MiniMax capability row (ratio pixel-map grid, seed on)", () => {
      const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.MiniMax];
      expect(caps.supportsNegativePrompt).toBe(false);
      expect(caps.supportsSamplers).toBe(false);
      expect(caps.supportsSeed).toBe(true);
      expect(caps.noApiKey).toBe(false);
      expect(caps.localExecution).toBe(false);
      expect(caps.paramRanges).toEqual({});
      if (caps.sizeSupport.kind !== "vendor-set") throw new Error("expected vendor-set");
      expect(caps.sizeSupport.sizes).toEqual([...MINIMAX_ASPECT_RATIOS.keys()]);
    });

    it("registers the minimax slug at import time (creatable via the registry)", () => {
      const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.MiniMax, {
        endpoint: MINIMAX_ENDPOINT,
        apiKey: "mm-key",
      });
      expect(typeof backend.generate).toBe("function");
      expect(typeof backend.listModels).toBe("function");
    });

    it("accepts a pasted full generation URL and a /v1 baseUrl (paste tolerance)", () => {
      for (const endpoint of [
        "https://api.minimax.io",
        "https://api.minimax.io/",
        "https://api.minimax.io/v1",
        "https://api.minimax.io/v1/image_generation",
      ]) {
        expect(() =>
          createImageGenBackend(IMAGE_GEN_BACKENDS.MiniMax, { endpoint, apiKey: "k" }),
        ).not.toThrow();
      }
    });
  });
});

// ─── Volcengine Ark / Seedream (PE-2 unit 3) ─────────────────────

const VOLCENGINE_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3";

describe("volcengine (openai-images family, invalid-post probe)", () => {
  const make = (transport: typeof fetch) =>
    familyBackend(IMAGE_GEN_BACKENDS.Volcengine, transport, VOLCENGINE_ENDPOINT, "ark-key");

  describe("generate", () => {
    it("sends verbatim WxH size, b64_json, and the watermark:false named decision", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);

      await backend.generate({
        prompt: "таверна в сумерках", // 5.0 pro accepts RU (the card's differentiator)
        model: "doubao-seedream-5-0-pro-260628",
        width: 2048,
        height: 2048,
      });

      expect(calls[0].url).toBe(`${VOLCENGINE_ENDPOINT}/images/generations`);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ark-key");
      const body = sentJson(calls[0]);
      expect(body.model).toBe("doubao-seedream-5-0-pro-260628");
      expect(body.size).toBe("2048x2048");
      expect(body.response_format).toBe("b64_json");
      // NAMED DECISION: the vendor default stamps "AI 生成" — VT opts out.
      expect(body.watermark).toBe(false);
      // No negative/seed/steps/sampler surface → never invented.
      expect("negative_prompt" in body).toBe(false);
      expect("seed" in body).toBe(false);
      expect("steps" in body).toBe(false);
      // No v1 seams: sequential/stream/tools/optimize never sent.
      expect("sequential_image_generation" in body).toBe(false);
      expect("stream" in body).toBe(false);
      expect("optimize_prompt_options" in body).toBe(false);
    });

    it("omits size when unset (vendor default; tier tokens have no v1 seam)", async () => {
      const { transport, calls } = makeTransport(() => b64DataResponse([PNG_BYTES]));
      const backend = make(transport);
      await backend.generate({ prompt: "p", model: "doubao-seedream-5-0-pro-260628" });
      expect("size" in sentJson(calls[0])).toBe(false);
    });
  });

  describe("listModels + probe", () => {
    it("returns the static documented-id catalog without any HTTP call", async () => {
      const { transport, calls } = makeTransport(() => Response.json({}));
      const backend = make(transport);
      const models = await backend.listModels();
      // Only the one FULL documented id — lite/4.5/4.0 ids are not on the
      // page, and the adapter never invents them.
      expect(models).toEqual([
        { id: "doubao-seedream-5-0-pro-260628", label: "Seedream 5.0 Pro" },
      ]);
      expect(calls).toHaveLength(0);
    });

    it("probes via invalid-post: a validation 4xx means credentials were ACCEPTED", async () => {
      const { transport, calls } = makeTransport(
        () =>
          Response.json(
            { error: { code: "InvalidParameter", message: "prompt is required" } },
            { status: 400 },
          ),
      );
      const backend = make(transport);
      const probed = await backend.probe();
      expect(probed).toEqual({ ok: true, detail: "credentials accepted — 1 static models" });
      // The empty-body POST can never generate (no model, no prompt).
      expect(calls[0].url).toBe(`${VOLCENGINE_ENDPOINT}/images/generations`);
      expect(sentJson(calls[0])).toEqual({});
    });

    it("probe fails on 401 (the live-probed AuthenticationError shape)", async () => {
      const { transport } = makeTransport(
        () =>
          Response.json(
            { error: { code: "AuthenticationError", message: "the API key is missing or invalid" } },
            { status: 401 },
          ),
      );
      const backend = make(transport);
      const probed = await backend.probe();
      expect(probed.ok).toBe(false);
      expect(probed.status).toBe(401);
      expect(probed.detail).toContain("credentials rejected");
    });
  });

  describe("capability row + registry", () => {
    it("pins the Volcengine capability row (free sizes, all-off params)", () => {
      const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.Volcengine];
      expect(caps.supportsNegativePrompt).toBe(false);
      expect(caps.supportsSamplers).toBe(false);
      expect(caps.supportsSeed).toBe(false);
      expect(caps.sizeSupport).toEqual({ kind: "free" });
      expect(caps.noApiKey).toBe(false);
      expect(caps.localExecution).toBe(false);
      expect(caps.paramRanges).toEqual({});
    });

    it("registers the volcengine slug at import time (creatable via the registry)", () => {
      const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.Volcengine, {
        endpoint: VOLCENGINE_ENDPOINT,
        apiKey: "ark-key",
      });
      expect(typeof backend.generate).toBe("function");
      expect(typeof backend.listModels).toBe("function");
    });
  });
});

// ─── DashScope (PE-2 unit 4) ──────────────────────────────

const DASHSCOPE_ENDPOINT = "https://dashscope-intl.aliyuncs.com/api/v1";

describe("dashscope (custom-JSON arm, sync + async)", () => {
  const make = (transport: typeof fetch) =>
    familyBackend(IMAGE_GEN_BACKENDS.Dashscope, transport, DASHSCOPE_ENDPOINT, "sk-key");

  /** A choices[] body with one image entry (the shape both the sync
   *  response and a SUCCEEDED task carry). */
  function choicesBody(imageUrl: string, usage: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      output: {
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: [{ image: imageUrl, type: "image" }, { text: "echo" }],
            },
          },
        ],
      },
      usage,
      request_id: "req-1",
    };
  }

  describe("generate — SYNC (qwen-image / z-image)", () => {
    it("sends the chat-shaped body with the ASTERISK size format and qwen-only negative_prompt", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json(choicesBody("https://oss.example/a.png", { width: 832, height: 1248 })),
      );
      const download = makeTransport(
        () => new Response(new Uint8Array(PNG_BYTES), { status: 200, headers: { "content-type": "image/png" } }),
      );
      let answered = false;
      const combined: typeof fetch = (url, init) => {
        if (!answered) {
          answered = true;
          return transport(url, init);
        }
        return download.transport(url, init);
      };

      const backend = make(combined);
      const result = await backend.generate({
        prompt: "таверна в сумерках",
        model: "qwen-image-3.0-pro",
        width: 832,
        height: 1248,
        negativePrompt: "blurry",
        seed: 123,
      });

      expect(calls[0].url).toBe(`${DASHSCOPE_ENDPOINT}/services/aigc/multimodal-generation/generation`);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-key");
      expect("X-DashScope-Async" in headers).toBe(false);
      const body = sentJson(calls[0]);
      expect(body.model).toBe("qwen-image-3.0-pro");
      expect(body.input).toEqual({
        messages: [{ role: "user", content: [{ text: "таверна в сумерках" }] }],
      });
      // ASTERISK separator — DashScope's own format, not "WxH".
      expect(body.parameters.size).toBe("832*1248");
      // qwen-image surface: negative rides; seed (edit-path-only per the
      // card) does NOT; watermark (not in the qwen t2i example) does not.
      expect(body.parameters.negative_prompt).toBe("blurry");
      expect("seed" in body.parameters).toBe(false);
      expect("watermark" in body.parameters).toBe(false);
      // prompt_extend never sent — the vendor default stands.
      expect("prompt_extend" in body.parameters).toBe(false);
      // The 24 h OSS URL is downloaded server-side; usage.width/height ride.
      expect(result.images[0].data.equals(PNG_BYTES)).toBe(true);
      expect(result.width).toBe(832);
      expect(result.height).toBe(1248);
    });

    it("z-image: seed rides, negative does NOT (no surface), asterisk size", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json(choicesBody("https://oss.example/z.png")),
      );
      let answered = false;
      const combined: typeof fetch = (url, init) => {
        if (!answered) {
          answered = true;
          return transport(url, init);
        }
        return Promise.resolve(new Response(new Uint8Array(PNG_BYTES), { status: 200 }));
      };
      const backend = make(combined);
      await backend.generate({
        prompt: "p",
        model: "z-image-turbo",
        width: 1024,
        height: 1024,
        seed: 777,
        negativePrompt: "noise",
      });
      const body = sentJson(calls[0]);
      expect(body.parameters.seed).toBe(777);
      expect("negative_prompt" in body.parameters).toBe(false);
      expect(body.parameters.size).toBe("1024*1024");
    });
  });

  describe("generate — ASYNC (wan2.7)", () => {
    it("submits with X-DashScope-Async, polls the task, downloads the image, parses usage.size", async () => {
      const taskBody = {
        request_id: "r2",
        output: {
          task_id: "task-42",
          task_status: "SUCCEEDED",
          finished: true,
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: [{ image: "https://oss.example/w.png", type: "image" }],
              },
            },
          ],
        },
        usage: { size: "2976*1408", image_count: 1 },
      };
      const { transport, calls } = makeTransport(() => Response.json(taskBody));
      let step = 0;
      const scripted: typeof fetch = (url, init) => {
        step += 1;
        void transport; // record via the transport double below
        void calls;
        if (step === 1) {
          // The async submit — PENDING first (the poll loop runs once).
          return Promise.resolve(
            Response.json({ output: { task_id: "task-42", task_status: "PENDING" }, request_id: "r1" }),
          );
        }
        if (step === 2) {
          return Promise.resolve(Response.json(taskBody));
        }
        return Promise.resolve(new Response(new Uint8Array(PNG_BYTES), { status: 200 }));
      };
      const recorded: RecordedCall[] = [];
      const recording: typeof fetch = (url, init) => {
        recorded.push({ url: String(url), init });
        return scripted(url, init);
      };

      const backend = make(recording);
      const result = await backend.generate({
        prompt: "p",
        model: "wan2.7-image-pro",
        width: 2976,
        height: 1408,
        negativePrompt: "unwanted", // wan REJECTS negative_prompt — dropped
      });

      // Submit hit the ASYNC path with the header.
      expect(recorded[0].url).toBe(`${DASHSCOPE_ENDPOINT}/services/aigc/image-generation/generation`);
      const submitHeaders = recorded[0].init?.headers as Record<string, string>;
      expect(submitHeaders["X-DashScope-Async"]).toBe("enable");
      const submitBody = sentJson(recorded[0]);
      expect(submitBody.model).toBe("wan2.7-image-pro");
      expect(submitBody.parameters.size).toBe("2976*1408");
      // The guide's own example value — the watermark-off named decision.
      expect(submitBody.parameters.watermark).toBe(false);
      // wan REJECTS negative_prompt — the adapter drops it.
      expect("negative_prompt" in submitBody.parameters).toBe(false);
      // The poll hit the tasks endpoint.
      expect(recorded[1].url).toBe(`${DASHSCOPE_ENDPOINT}/tasks/task-42`);
      // The image downloaded; usage.size "2976*1408" parsed onto the result.
      expect(result.images[0].data.equals(PNG_BYTES)).toBe(true);
      expect(result.width).toBe(2976);
      expect(result.height).toBe(1408);
    });
  });

  describe("pollDashScopeTask (exported seam)", () => {
    it("polls PENDING→RUNNING→SUCCEEDED with the injected wait (no sleeps)", async () => {
      const statuses = ["PENDING", "RUNNING", "SUCCEEDED"];
      const done = {
        output: { task_id: "t", task_status: "SUCCEEDED", choices: [] },
        usage: { size: "1024*1024" },
      };
      let i = 0;
      const waits: number[] = [];
      const fetchDouble: typeof fetch = () => {
        const status = statuses[i];
        i += 1;
        return Promise.resolve(
          status === "SUCCEEDED"
            ? Response.json(done)
            : Response.json({ output: { task_id: "t", task_status: status } }),
        );
      };
      const root = await pollDashScopeTask({
        endpoint: DASHSCOPE_ENDPOINT,
        apiKey: "sk-key",
        taskId: "t",
        fetch: fetchDouble,
        wait: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      });
      expect(root.output).toEqual(done.output);
      // Two waits (after PENDING, after RUNNING), guide cadence 3 s.
      expect(waits).toEqual([3000, 3000]);
    });

    it("throws on FAILED with the documented output.code/message", async () => {
      const fetchDouble: typeof fetch = () =>
        Promise.resolve(
          Response.json({
            output: { task_id: "t", task_status: "FAILED", code: "DataInspectionFailed", message: "flagged" },
          }),
        );
      await expect(
        pollDashScopeTask({
          endpoint: DASHSCOPE_ENDPOINT,
          apiKey: "sk-key",
          taskId: "t",
          fetch: fetchDouble,
          wait: () => Promise.resolve(),
        }),
      ).rejects.toThrow(/FAILED \(code DataInspectionFailed: flagged\)/);
    });
  });

  describe("listModels + probe", () => {
    it("returns the static trio without any HTTP call", async () => {
      const { transport, calls } = makeTransport(() => Response.json({}));
      const backend = make(transport);
      const models = await backend.listModels();
      expect(models.map((m) => m.id)).toEqual([
        "qwen-image-3.0-pro",
        "wan2.7-image-pro",
        "z-image-turbo",
      ]);
      expect(calls).toHaveLength(0);
    });

    it("probes via invalid-post on the SYNC endpoint (401 = rejected, 400 = accepted)", async () => {
      const rejected = makeTransport(
        () => Response.json({ message: "Unauthorized" }, { status: 401 }),
      );
      const bad = await make(rejected.transport).probe();
      expect(bad.ok).toBe(false);
      expect(bad.status).toBe(401);

      const accepted = makeTransport(
        () => Response.json({ code: "InvalidParameter", message: "model required" }, { status: 400 }),
      );
      const good = await make(accepted.transport).probe();
      expect(good).toEqual({ ok: true, detail: "credentials accepted — 3 static models" });
    });
  });

  describe("capability row + registry", () => {
    it("pins the DashScope capability row (negative qwen-only, seed z-image-only, free sizes)", () => {
      const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.Dashscope];
      expect(caps.supportsNegativePrompt).toBe(true);
      expect(caps.supportsSamplers).toBe(false);
      expect(caps.supportsSeed).toBe(true);
      expect(caps.sizeSupport).toEqual({ kind: "free" });
      expect(caps.noApiKey).toBe(false);
      expect(caps.localExecution).toBe(false);
      expect(caps.paramRanges).toEqual({});
    });

    it("registers the dashscope slug at import time (creatable via the registry)", () => {
      const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.Dashscope, {
        endpoint: DASHSCOPE_ENDPOINT,
        apiKey: "sk-key",
      });
      expect(typeof backend.generate).toBe("function");
      expect(typeof backend.listModels).toBe("function");
    });
  });
});

// ─── Z.AI (PE-2 unit 1) ──────────────────────────────────────────────────

const ZAI_ENDPOINT = "https://api.z.ai/api/paas/v4";

describe("zai (openai-images family, static catalog)", () => {
  const make = (transport: typeof fetch) =>
    familyBackend(IMAGE_GEN_BACKENDS.Zai, transport, ZAI_ENDPOINT, "z-key");

  describe("generate", () => {
    it("sends model/prompt/size from the documented union grid and NO response_format (card has none)", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({ data: [{ url: "https://cdn.z.ai/img.png" }] }),
      );
      const download = makeTransport(() => new Response(new Uint8Array(PNG_BYTES), { status: 200 }));
      // First call answers the generation POST; the server-side download of
      // data[0].url goes through the SAME seam — script both in order.
      let generationAnswered = false;
      const combined: typeof fetch = (url, init) => {
        if (!generationAnswered) {
          generationAnswered = true;
          return transport(url, init);
        }
        return download.transport(url, init);
      };

      const backend = make(combined);
      const result = await backend.generate({
        prompt: "a tavern at dusk",
        model: "glm-image",
        width: 1728,
        height: 960,
      });

      expect(calls[0].url).toBe(`${ZAI_ENDPOINT}/images/generations`);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer z-key");
      const body = sentJson(calls[0]);
      expect(body.model).toBe("glm-image");
      expect(body.prompt).toBe("a tavern at dusk");
      expect(body.size).toBe("1728x960");
      // No response_format param on the card — never invented.
      expect("response_format" in body).toBe(false);
      // quality / user_id have no contract seam — never sent.
      expect("quality" in body).toBe(false);
      expect("user_id" in body).toBe(false);
      // data[0].url delivery (30-day expiry) — bytes downloaded server-side.
      expect(result.images).toHaveLength(1);
      expect(result.images[0].data.equals(PNG_BYTES)).toBe(true);
    });

    it("fails closed off-grid; in-range custom pairs ride verbatim via user sizes (IG-20a)", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({ data: [{ url: "https://cdn.z.ai/img.png" }] }),
      );
      const backend = make(transport);
      // 1000x1000 is neither on either model's enum nor divisible by 32.
      await expect(
        backend.generate({ prompt: "p", model: "glm-image", width: 1000, height: 1000 }),
      ).rejects.toThrow(/Z\.AI has no documented size for 1000x1000/);
      expect(calls).toHaveLength(0);

      // 1600x1024: in the glm-image custom range (1024–2048, div 32) — the
      // user entry IS the vendor claim, rides verbatim.
      const user = makeTransport(() =>
        Response.json({ data: [{ url: "https://cdn.z.ai/img.png" }] }),
      );
      const userBackend = createImageGenBackend(IMAGE_GEN_BACKENDS.Zai, {
        endpoint: ZAI_ENDPOINT,
        apiKey: "z-key",
        userSizes: [{ width: 1600, height: 1024 }],
        fetch: user.transport,
      });
      // generate → 200 with url; the download goes through the same seam
      // (the double answers any call with the same JSON — the download
      // failing JSON parse is fine for this wire-only assertion... but the
      // download path requires bytes. Use a two-phase double.
      let answered = false;
      const twoPhase: typeof fetch = (url, init) => {
        if (!answered) {
          answered = true;
          return user.transport(url, init);
        }
        return Promise.resolve(new Response(new Uint8Array(PNG_BYTES), { status: 200 }));
      };
      const viaUser = createImageGenBackend(IMAGE_GEN_BACKENDS.Zai, {
        endpoint: ZAI_ENDPOINT,
        apiKey: "z-key",
        userSizes: [{ width: 1600, height: 1024 }],
        fetch: twoPhase,
      });
      await viaUser.generate({ prompt: "p", model: "glm-image", width: 1600, height: 1024 });
      expect(sentJson(user.calls[0]).size).toBe("1600x1024");
    });
  });

  describe("listModels + probe", () => {
    it("returns the STATIC documented catalog without any HTTP call", async () => {
      const { transport, calls } = makeTransport(() => Response.json({ data: [] }));
      const backend = make(transport);
      const models = await backend.listModels();
      expect(models).toEqual([
        { id: "glm-image", label: "GLM Image" },
        { id: "cogview-4-250304", label: "CogView-4" },
      ]);
      expect(calls).toHaveLength(0);
    });

    it("probes creds via the CHAT GET /models and counts the static image enum, not the chat catalog", async () => {
      const { transport, calls } = makeTransport(() =>
        Response.json({ data: [{ id: "glm-4.7" }, { id: "glm-4.7-air" }] }),
      );
      const backend = make(transport);
      const probed = await backend.probe();
      expect(probed).toEqual({ ok: true, detail: "2 image models (static catalog)" });
      expect(calls[0].url).toBe(`${ZAI_ENDPOINT}/models`);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer z-key");
    });

    it("probe fails on auth rejection", async () => {
      const { transport } = makeTransport(() =>
        Response.json({ error: { message: "Invalid key" } }, { status: 401 }),
      );
      const backend = make(transport);
      const probed = await backend.probe();
      expect(probed.ok).toBe(false);
      expect(probed.status).toBe(401);
    });
  });

  describe("capability row + registry", () => {
    it("pins the Z.AI capability row (vendor-set 14-entry union grid, all-off params)", () => {
      const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.Zai];
      expect(caps.supportsNegativePrompt).toBe(false);
      expect(caps.supportsSamplers).toBe(false);
      expect(caps.supportsSeed).toBe(false);
      expect(caps.noApiKey).toBe(false);
      expect(caps.localExecution).toBe(false);
      expect(caps.paramRanges).toEqual({});
      if (caps.sizeSupport.kind !== "vendor-set") throw new Error("expected vendor-set");
      // Lockstep: the capability grid IS the adapter's documented grid.
      expect(caps.sizeSupport.sizes).toEqual([...ZAI_IMAGE_SIZES.keys()]);
    });

    it("registers the zai slug at import time (creatable via the registry)", () => {
      const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.Zai, {
        endpoint: ZAI_ENDPOINT,
        apiKey: "z-key",
      });
      expect(typeof backend.generate).toBe("function");
      expect(typeof backend.listModels).toBe("function");
    });
  });
});
