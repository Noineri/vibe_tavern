/**
 * Unit tests for the Krea image-gen backend (IF-11, IMAGEGEN_FOLLOWUP_REPORT
 * item 11) — mocked transport at the config-injected fetch seam (tier T1:
 * the double is a function argument, no mock.module, no globalThis patches).
 * Every pinned shape traces to the LIVE OpenAPI spec at
 * https://api.krea.ai/openapi.json (fetched 2026-09-26) and their docs
 * (krea-2 overview + generative-sliders pages); the anonymous no-key ladder
 * (empty POST → 401 {"message":"Unauthorized"}) was probed live 2026-09-26.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import {
  KREA_DEFAULT_MODEL,
  KreaImageConfigError,
  KreaImageError,
  kreaImageFactory,
  mapKreaAspectRatio,
  parseKreaCatalog,
  pollKreaJob,
  resetKreaSpecCacheForTests,
} from "../src/domain/imagegen/backends/krea.js";
import { createImageGenBackend } from "../src/domain/imagegen/imagegen-registry.js";

const ENDPOINT = "https://api.krea.ai";
const API_KEY = "krea-key";

/** Known 8-byte PNG-magic payload. */
const PNG_BYTES = Buffer.from("iVBORw0KGgo=", "base64");

// ─── Spec fixture ────────────────────────────────────────────────────────────

/** The spec shapes the adapter reads, mirrored from the live 3.1 spec: the
 *  krea-2 trio's own fields (creativity + sliders), z-image's boolean
 *  expansion switch, nano-banana's pixel-size dialect — plus a video path
 *  and a prompt-less body that must BOTH stay out of the catalog. */
function miniSpec(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    paths: {
      "/generate/image/krea/krea-2/medium": {
        post: {
          summary: "Krea 2 Medium",
          requestBody: { content: { "application/json": { schema: {
            type: "object",
            additionalProperties: false,
            required: ["prompt", "aspect_ratio", "resolution"],
            properties: {
              prompt: { type: "string" },
              seed: { type: ["number", "null"] },
              aspect_ratio: { type: "string", enum: ["1:1", "4:3", "4:5", "9:16", "2.35:1"] },
              resolution: { type: "string", enum: ["1K"] },
              creativity: { type: "string", enum: ["raw", "low", "medium", "high"], default: "low" },
              intensity: { type: "integer", minimum: -100, maximum: 100, default: 0 },
              complexity: { type: "integer", minimum: -100, maximum: 100, default: 0 },
              movement: { type: "integer", minimum: -100, maximum: 100, default: 0 },
            },
          } } } },
        },
      },
      "/generate/image/z-image/z-image": {
        post: {
          summary: "Z Image",
          requestBody: { content: { "application/json": { schema: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              skip_prompt_expansion: { type: "boolean", default: false },
              aspect_ratio: { type: "string", enum: ["1:1", "4:3", "16:9"] },
              resolution: { type: "string", enum: ["1K"] },
              seed: { type: "number" },
            },
          } } } },
        },
      },
      "/generate/image/google/nano-banana": {
        post: {
          summary: "Nano Banana",
          requestBody: { content: { "application/json": { schema: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              width: { type: "number" },
              height: { type: "number" },
            },
          } } } },
        },
      },
      // A video path — out of the image catalog by prefix rule.
      "/generate/video/kling/kling-3": {
        post: {
          summary: "Kling 3",
          requestBody: { content: { "application/json": { schema: {
            type: "object",
            properties: { prompt: { type: "string" } },
          } } } },
        },
      },
      // An image path whose body has no prompt — skipped, never thrown.
      "/generate/image/broken/no-prompt": {
        post: {
          summary: "Broken",
          requestBody: { content: { "application/json": { schema: {
            type: "object",
            properties: { aspect_ratio: { type: "string", enum: ["1:1"] } },
          } } } },
        },
      },
    },
  };
}

function specResponse(spec: Record<string, unknown> = miniSpec()): Response {
  return Response.json(spec);
}

function jobResponse(status: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ job_id: "11111111-2222-3333-4444-555555555555", status, ...extra });
}
// ─── Transport double ────────────────────────────────────────────────────────

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeTransport(
  handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  const calls: RecordedCall[] = [];
  const transport = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    const headerInit = init?.headers;
    if (headerInit !== undefined) {
      // Headers normalizes keys to lowercase — record them that way.
      for (const [key, value] of new Headers(headerInit).entries()) headers[key.toLowerCase()] = value;
    }
    let body: unknown = undefined;
    if (init?.body !== undefined && typeof init.body === "string") {
      body = JSON.parse(init.body) as Record<string, unknown>;
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body,
    });
    if (init?.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    return handler(new URL(String(input)), init);
  };
  return { transport, calls };
}

// The generic script builder used by generate tests.
function scriptKrea(options: {
  spec?: Response;
  submit?: Response;
  polls?: Response[];
  imageStatus?: number;
  imageHeaders?: Record<string, string>;
  imageUrl?: string;
}) {
  const defaultImageUrl = options.imageUrl ?? "https://cdn.krea.ai/img.png";
  const polls = [...(options.polls ?? [jobResponse("completed", { result: { urls: [defaultImageUrl] } })])];
  let pollIndex = 0;
  let imageFetches = 0;
  return makeTransport((url, init) => {
    const path = url.pathname;
    if (path === "/openapi.json") {
      return options.spec ?? specResponse();
    }
    if (path.startsWith("/generate/image/")) {
      return options.submit ?? jobResponse("queued");
    }
    if (path.startsWith("/jobs/")) {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const response = polls[Math.min(pollIndex, polls.length - 1)] as Response;
      pollIndex += 1;
      // A Response body is single-use — hand out a fresh clone per poll.
      return response.clone();
    }
    // The image download.
    imageFetches += 1;
    if (options.imageStatus !== undefined && imageFetches === 1) {
      return new Response("denied", { status: options.imageStatus });
    }
    return new Response(PNG_BYTES, {
      status: 200,
      headers: { "content-type": "image/png", ...(options.imageHeaders ?? {}) },
    });
  });
}

beforeEach(() => {
  resetKreaSpecCacheForTests();
});

// ─── parseKreaCatalog ────────────────────────────────────────────────────────

describe("parseKreaCatalog (IF-11)", () => {
  it("parses image models only, with per-model enums and the pixel-size flag", () => {
    const catalog = parseKreaCatalog(miniSpec());
    expect([...catalog.models.keys()].sort()).toEqual([
      "google/nano-banana",
      "krea/krea-2/medium",
      "z-image/z-image",
    ]);
    const krea2 = catalog.models.get("krea/krea-2/medium")!;
    expect(krea2.summary).toBe("Krea 2 Medium");
    expect(krea2.aspectRatios).toEqual(["1:1", "4:3", "4:5", "9:16", "2.35:1"]);
    expect(krea2.resolutions).toEqual(["1K"]);
    expect(krea2.pixelSize).toBe(false);
    expect(krea2.properties.has("creativity")).toBe(true);
    const banana = catalog.models.get("google/nano-banana")!;
    expect(banana.pixelSize).toBe(true);
    expect(banana.aspectRatios).toBeUndefined();
    // Labels ride the spec's own summaries.
    expect(catalog.list.map((m) => m.label)).toEqual(["Krea 2 Medium", "Nano Banana", "Z Image"]);
  });

  it("survives junk without throwing — an empty catalog, not a crash", () => {
    expect(() => parseKreaCatalog(null)).not.toThrow();
    expect(() => parseKreaCatalog({ paths: { "/generate/image/x": { get: {} } } })).not.toThrow();
    expect(parseKreaCatalog({}).list).toEqual([]);
  });
});

// ─── mapKreaAspectRatio ──────────────────────────────────────────────────────

describe("mapKreaAspectRatio (IF-11)", () => {
  const KREA2_RATIOS = ["1:1", "4:3", "4:5", "9:16", "2.35:1"] as const;

  it("exact reductions hit verbatim; odd pairs map to the log-nearest ratio", () => {
    expect(mapKreaAspectRatio([...KREA2_RATIOS], 1024, 1024)).toBe("1:1");
    expect(mapKreaAspectRatio([...KREA2_RATIOS], 864, 648)).toBe("4:3");
    // 832×1216 (13:19) — nearest by log distance is 4:5 (0.684 vs 0.697).
    expect(mapKreaAspectRatio([...KREA2_RATIOS], 832, 1216)).toBe("4:5");
    // 2.35:1 = 47:20 exactly.
    expect(mapKreaAspectRatio([...KREA2_RATIOS], 940, 400)).toBe("2.35:1");
    // Portrait nearest 9:16.
    expect(mapKreaAspectRatio([...KREA2_RATIOS], 720, 1600)).toBe("9:16");
  });

  it("missing or non-positive sizes never guess", () => {
    expect(mapKreaAspectRatio([...KREA2_RATIOS])).toBeUndefined();
    expect(mapKreaAspectRatio([...KREA2_RATIOS], 0, 100)).toBeUndefined();
    expect(mapKreaAspectRatio([], 100, 100)).toBeUndefined();
  });
});

// ─── Config errors ───────────────────────────────────────────────────────────

describe("krea config (IF-11)", () => {
  it("missing endpoint or key fails fast at factory time", () => {
    expect(() => kreaImageFactory({ endpoint: "", apiKey: "k" })).toThrow(KreaImageConfigError);
    expect(() => kreaImageFactory({ endpoint: ENDPOINT, apiKey: " " })).toThrow(KreaImageConfigError);
    // Paste tolerance: a /v1-suffixed base still works.
    expect(() => kreaImageFactory({ endpoint: `${ENDPOINT}/v1`, apiKey: "k" })).not.toThrow();
  });

  it("registers on the slug and serves through the registry", () => {
    const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.Krea, {
      endpoint: ENDPOINT,
      apiKey: API_KEY,
    });
    expect(typeof backend.generate).toBe("function");
  });
});

// ─── generate ────────────────────────────────────────────────────────────────

describe("krea generate (IF-11)", () => {
  it("submits a schema-filtered body, polls the job, downloads the bytes keyless", async () => {
    const script = scriptKrea({});
    const backend = kreaImageFactory({ endpoint: ENDPOINT, apiKey: API_KEY, fetch: script.transport });

    const result = await backend.generate({
      prompt: "silver-haired tavern keeper",
      model: "krea/krea-2/medium",
      width: 1024,
      height: 1024,
      seed: 42,
      // Extraneous request fields (a1111 dialect leftovers) must NEVER ride
      // the strict body.
      steps: 30,
      cfgScale: 7,
      sampler: "euler",
    });

    expect(result.images[0]!.data.equals(PNG_BYTES)).toBe(true);
    expect(result.images[0]!.mimeType).toBe("image/png");

    const submit = script.calls.find((call) => call.method === "POST" && call.url.includes("/generate/image/"))!;
    expect(submit.url).toBe(`${ENDPOINT}/generate/image/krea/krea-2/medium`);
    expect(submit.body).toEqual({
      prompt: "silver-haired tavern keeper",
      aspect_ratio: "1:1",
      resolution: "1K",
      seed: 42,
      // The policy default: authored prompts — no vendor expansion.
      creativity: "raw",
    });

    // The download went out keyless (the presigned expectation).
    const download = script.calls.find((call) => call.url.startsWith("https://cdn.krea.ai/"))!;
    expect(download.headers["authorization"]).toBeUndefined();
  });

  it("overlay krea params ride: creativity override + the three sliders", async () => {
    const script = scriptKrea({});
    const backend = kreaImageFactory({ endpoint: ENDPOINT, apiKey: API_KEY, fetch: script.transport });
    await backend.generate({
      prompt: "p",
      model: "krea/krea-2/medium",
      width: 1024,
      height: 1024,
      krea: { creativity: "high", intensity: 40, complexity: -60, movement: 30 },
    });
    const submit = script.calls.find((call) => call.method === "POST" && call.url.includes("/generate/image/"))!;
    expect(submit.body).toEqual({
      prompt: "p",
      aspect_ratio: "1:1",
      resolution: "1K",
      creativity: "high",
      intensity: 40,
      complexity: -60,
      movement: 30,
    });
  });

  it("z-image gets skip_prompt_expansion and never a creativity field", async () => {
    const script = scriptKrea({});
    const backend = kreaImageFactory({ endpoint: ENDPOINT, apiKey: API_KEY, fetch: script.transport });
    await backend.generate({ prompt: "p", model: "z-image/z-image", width: 800, height: 600 });
    const submit = script.calls.find((call) => call.method === "POST" && call.url.includes("/generate/image/"))!;
    expect(submit.body).toEqual({
      prompt: "p",
      aspect_ratio: "4:3",
      resolution: "1K",
      skip_prompt_expansion: true,
    });
  });

  it("pixel-size models (nano-banana) get the integer W/H pair, no aspect/resolution", async () => {
    const script = scriptKrea({});
    const backend = kreaImageFactory({ endpoint: ENDPOINT, apiKey: API_KEY, fetch: script.transport });
    await backend.generate({ prompt: "p", model: "google/nano-banana", width: 1024.4, height: 768.9 });
    const submit = script.calls.find((call) => call.method === "POST" && call.url.includes("/generate/image/"))!;
    expect(submit.body).toEqual({ prompt: "p", width: 1024, height: 769 });
  });

  it("a model unknown to the cached spec forces ONE refresh, then fails named", async () => {
    let specFetches = 0;
    const script = makeTransport((url) => {
      if (url.pathname === "/openapi.json") {
        specFetches += 1;
        return specResponse();
      }
      return new Response("nope", { status: 404 });
    });
    const backend = kreaImageFactory({ endpoint: ENDPOINT, apiKey: API_KEY, fetch: script.transport });
    // Prime the cache with a first listModels call...
    await backend.listModels();
    expect(specFetches).toBe(1);
    // ...then ask for a model the cache does not know.
    await expect(
      backend.generate({ prompt: "p", model: "vendor/new-model", width: 100, height: 100 }),
    ).rejects.toThrow('Krea model "vendor/new-model" is not in the live spec catalog');
    expect(specFetches).toBe(2);
  });

  it("a failed job surfaces the code+message and cancels via DEL", async () => {
    const script = scriptKrea({
      polls: [jobResponse("failed", { error: { code: "safety_filter", message: "blocked" } })],
    });
    const backend = kreaImageFactory({ endpoint: ENDPOINT, apiKey: API_KEY, fetch: script.transport });
    await expect(
      backend.generate({ prompt: "p", model: "krea/krea-2/medium", width: 1, height: 1 }),
    ).rejects.toThrow(/safety_filter — blocked/);
    const del = script.calls.find((call) => call.method === "DELETE" && call.url.includes("/jobs/"));
    expect(del).toBeDefined();
  });

  it("submit 402 names the compute-units balance", async () => {
    const script = scriptKrea({
      submit: new Response(JSON.stringify({ message: "insufficient compute units" }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      }),
    });
    const backend = kreaImageFactory({ endpoint: ENDPOINT, apiKey: API_KEY, fetch: script.transport });
    await expect(
      backend.generate({ prompt: "p", model: "krea/krea-2/medium", width: 1, height: 1 }),
    ).rejects.toThrow(/compute units/);
  });

  it("urls variants: typed objects skip previews; url maps prefer the model key", async () => {
    // {type: "preview"} then {type: "model"} — the model URL is the one fetched.
    const typed = scriptKrea({
      polls: [
        jobResponse("completed", {
          result: { urls: [
            { type: "preview", url: "https://cdn.krea.ai/preview.png" },
            { type: "model", url: "https://cdn.krea.ai/model.png" },
          ] },
        }),
      ],
    });
    const backendTyped = kreaImageFactory({ endpoint: ENDPOINT, apiKey: API_KEY, fetch: typed.transport });
    await backendTyped.generate({ prompt: "p", model: "krea/krea-2/medium", width: 1, height: 1 });
    expect(typed.calls.some((call) => call.url === "https://cdn.krea.ai/model.png")).toBe(true);
    expect(typed.calls.some((call) => call.url === "https://cdn.krea.ai/preview.png")).toBe(false);

    const mapped = scriptKrea({
      polls: [
        jobResponse("completed", {
          result: { urls: { model: "https://cdn.krea.ai/map-model.png", preview: "https://cdn.krea.ai/map-prev.png" } },
        }),
      ],
    });
    const backendMapped = kreaImageFactory({ endpoint: ENDPOINT, apiKey: API_KEY, fetch: mapped.transport });
    await backendMapped.generate({ prompt: "p", model: "krea/krea-2/medium", width: 1, height: 1 });
    expect(mapped.calls.some((call) => call.url === "https://cdn.krea.ai/map-model.png")).toBe(true);
  });

  it("a keyless 401 download retries WITH the Bearer header", async () => {
    const script = scriptKrea({ imageStatus: 401 });
    const backend = kreaImageFactory({ endpoint: ENDPOINT, apiKey: API_KEY, fetch: script.transport });
    const result = await backend.generate({ prompt: "p", model: "krea/krea-2/medium", width: 1, height: 1 });
    expect(result.images[0]!.data.equals(PNG_BYTES)).toBe(true);
    const downloads = script.calls.filter((call) => call.url.startsWith("https://cdn.krea.ai/"));
    expect(downloads).toHaveLength(2);
    expect(downloads[0]!.headers["authorization"]).toBeUndefined();
    expect(downloads[1]!.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
  });
});

// ─── listModels + cache ──────────────────────────────────────────────────────

describe("krea listModels (IF-11)", () => {
  it("lists from the live spec and serves the second call from cache", async () => {
    let specFetches = 0;
    const script = makeTransport((url) => {
      if (url.pathname === "/openapi.json") {
        specFetches += 1;
        return specResponse();
      }
      return new Response("nope", { status: 404 });
    });
    const backend = kreaImageFactory({ endpoint: ENDPOINT, apiKey: API_KEY, fetch: script.transport });
    const first = await backend.listModels();
    expect(first.map((m) => m.id)).toContain("krea/krea-2/medium");
    const second = await backend.listModels();
    expect(second).toEqual(first);
    expect(specFetches).toBe(1);
  });
});

// ─── pollKreaJob seam ────────────────────────────────────────────────────────

describe("pollKreaJob (IF-11)", () => {
  const instantWait = (): Promise<void> => Promise.resolve();

  function pollTransport(responses: Response[]) {
    let index = 0;
    return makeTransport(() => {
      const response = responses[Math.min(index, responses.length - 1)] as Response;
      index += 1;
      return response.clone();
    });
  }

  it("polls through intermediate-complete to completed", async () => {
    const script = pollTransport([
      jobResponse("queued"),
      jobResponse("sampling"),
      jobResponse("intermediate-complete"),
      jobResponse("completed", { result: { urls: ["https://x/img.png"] } }),
    ]);
    const root = await pollKreaJob({
      jobId: "j",
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      fetch: script.transport,
      wait: instantWait,
    });
    expect(root.status).toBe("completed");
  });

  it("an unrecognized status fails closed with the raw text", async () => {
    const script = pollTransport([jobResponse("teleported")]);
    await expect(
      pollKreaJob({ jobId: "j", endpoint: ENDPOINT, apiKey: API_KEY, fetch: script.transport, wait: instantWait }),
    ).rejects.toThrow(/teleported/);
  });

  it("the budget expires with the last status named", async () => {
    const script = pollTransport([jobResponse("processing")]);
    await expect(
      pollKreaJob({ jobId: "j", endpoint: ENDPOINT, apiKey: API_KEY, fetch: script.transport, wait: instantWait }),
    ).rejects.toThrow(/150s \(last status: processing\)/);
  });
});

// ─── probe ───────────────────────────────────────────────────────────────────

describe("krea probe (IF-11)", () => {
  it("401 Unauthorized = credentials rejected (the live no-key shape)", async () => {
    const script = makeTransport(() =>
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const backend = kreaImageFactory({ endpoint: ENDPOINT, apiKey: "bad", fetch: script.transport });
    const result = await backend.probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Unauthorized");
    expect(result.detail).toContain("credentials rejected");
    // The probe posts an EMPTY body — it can never generate.
    expect(script.calls[0]!.body).toEqual({});
  });

  it("a 400 validation = auth accepted", async () => {
    const script = makeTransport(() =>
      new Response(JSON.stringify({ message: "prompt is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const backend = kreaImageFactory({ endpoint: ENDPOINT, apiKey: API_KEY, fetch: script.transport });
    const result = await backend.probe();
    expect(result.ok).toBe(true);
  });

  it("404 = endpoint wrong", async () => {
    const script = makeTransport(() => new Response("nope", { status: 404 }));
    const backend = kreaImageFactory({ endpoint: ENDPOINT, apiKey: API_KEY, fetch: script.transport });
    const result = await backend.probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("404");
  });
});
