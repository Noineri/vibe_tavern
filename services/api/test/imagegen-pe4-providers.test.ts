/**
 * PE-4 wire tests — the native-arm wave's provider backends (unit 1:
 * google). Same discipline as the PE-1/PE-2/PE-3 files: T1 transport
 * doubles through the config's fetch seam, every claim pinned against the
 * live-verified wire facts (re-verified 2026-09-18).
 */

import { describe, expect, it } from "bun:test";
import { IMAGE_GEN_BACKENDS, IMAGE_GEN_BACKEND_CAPABILITIES } from "@vibe-tavern/domain";

import { mapGoogleAspectRatio, mapGoogleImageSize } from "../src/domain/imagegen/backends/google.js";
import { mapStabilityAspectRatio } from "../src/domain/imagegen/backends/stability.js";
import { createImageGenBackend } from "../src/domain/imagegen/imagegen-registry.js";
// Import-time side-effect registrations are the production wiring.
import "../src/domain/imagegen/backends/google.js";

// ─── Shared helpers (the PE-1/PE-2/PE-3 files' verbatim discipline) ─────────

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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Minimal PNG bytes (magic prefix is what the sniffer needs). */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function make(transport: typeof fetch, endpoint = "https://generativelanguage.googleapis.com") {
  return createImageGenBackend(IMAGE_GEN_BACKENDS.Google, {
    endpoint,
    apiKey: "g-key",
    fetch: transport,
  });
}

/** An interaction payload with one model_output image block. */
function interactionWithImages(images: Array<{ data: string; mime_type?: string }>): unknown {
  return {
    object: "interaction",
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: images.map((image) => ({
          type: "image",
          data: image.data,
          ...(image.mime_type !== undefined ? { mime_type: image.mime_type } : {}),
        })),
      },
    ],
    usage: {},
  };
}

// ─── google (Nano Banana, Interactions API) ──────────────────────────────────

describe("google native arm (Interactions API, inline base64)", () => {
  it("POSTs {model, input, store:false} to /v1beta/interactions with x-goog-api-key — no response_format without a size, no Authorization header", async () => {
    const t = makeTransport(() => jsonResponse(interactionWithImages([{ data: PNG_BYTES.toString("base64") }])));
    const backend = make(t.transport);
    const result = await backend.generate({ prompt: "a nano banana dish" });
    expect(t.calls).toHaveLength(1);
    const call = t.calls[0];
    expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    const headers = call.init?.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("g-key");
    expect(headers.Authorization).toBeUndefined();
    const body = sentJson(call);
    expect(body.model).toBe("gemini-3.1-flash-image"); // documented default
    expect(body.input).toEqual([{ type: "text", text: "a nano banana dish" }]);
    expect(body.store).toBe(false); // no vendor-side retention (named decision)
    expect(body.response_format).toBeUndefined();
    expect(body.negative_prompt).toBeUndefined();
    expect(body.seed).toBeUndefined();
    expect(result.images[0]?.data.equals(PNG_BYTES)).toBe(true);
    expect(result.images[0]?.mimeType).toBe("image/png");
  });

  it("maps width/height onto response_format {aspect_ratio, image_size} — nearest documented values, per-request model override wins", async () => {
    const t = makeTransport(() => jsonResponse(interactionWithImages([{ data: PNG_BYTES.toString("base64"), mime_type: "image/png" }])));
    await make(t.transport).generate({ prompt: "p", model: "gemini-3-pro-image", width: 2048, height: 2048 });
    const body = sentJson(t.calls[0]);
    expect(body.model).toBe("gemini-3-pro-image");
    expect(body.response_format).toEqual({ type: "image", aspect_ratio: "1:1", image_size: "2K" });
  });

  it("sends 1024x576 → {16:9, 1K}; never sends negative/seed/steps/cfg even when the request carries them", async () => {
    const t = makeTransport(() => jsonResponse(interactionWithImages([{ data: PNG_BYTES.toString("base64") }])));
    await make(t.transport).generate({
      prompt: "p",
      negativePrompt: "no",
      seed: 7,
      steps: 30,
      cfgScale: 4.5,
      sampler: "euler",
      width: 1024,
      height: 576,
    });
    const body = sentJson(t.calls[0]);
    expect(body.response_format).toEqual({ type: "image", aspect_ratio: "16:9", image_size: "1K" });
    expect(JSON.stringify(body)).not.toContain("negative");
    expect(JSON.stringify(body)).not.toContain("seed");
    expect(JSON.stringify(body)).not.toContain("steps");
    expect(JSON.stringify(body)).not.toContain("cfg");
    expect(JSON.stringify(body)).not.toContain("sampler");
  });

  it("takes the LAST model_output image (Pro interleaves) and ignores thought-step interim images", async () => {
    const interim = Buffer.from("interim-bytes-not-png");
    const first = PNG_BYTES.toString("base64");
    const last = "QUJD"; // "ABC"
    const payload = {
      status: "completed",
      steps: [
        { type: "thought", content: [{ type: "image", data: interim.toString("base64"), mime_type: "image/png" }] },
        { type: "model_output", content: [{ type: "image", data: first, mime_type: "image/png" }] },
        { type: "model_output", content: [{ type: "image", data: last, mime_type: "image/png" }] },
      ],
    };
    const t = makeTransport(() => jsonResponse(payload));
    const result = await make(t.transport).generate({ prompt: "p" });
    expect(result.images[0]?.data.toString("utf8")).toBe("ABC");
  });

  it("falls back to a thought-step image when no model_output image exists", async () => {
    const payload = {
      status: "completed",
      steps: [{ type: "thought", content: [{ type: "image", data: PNG_BYTES.toString("base64") }] }],
    };
    const t = makeTransport(() => jsonResponse(payload));
    const result = await make(t.transport).generate({ prompt: "p" });
    expect(result.images[0]?.mimeType).toBe("image/png"); // sniffed, mime_type absent
  });

  it("surfaces a 200-without-image as a typed error carrying the vendor message; a bare 200 as the no-image error", async () => {
    const withError = makeTransport(() =>
      jsonResponse([{ error: { code: 400, message: "Safety refusal", status: "INVALID_ARGUMENT" } }]),
    );
    await expect(make(withError.transport).generate({ prompt: "p" })).rejects.toThrow(
      "returned no image: Safety refusal",
    );
    const bare = makeTransport(() => jsonResponse({ status: "completed", steps: [] }));
    await expect(make(bare.transport).generate({ prompt: "p" })).rejects.toThrow(
      "returned no image block",
    );
  });

  it("maps non-2xx to a typed error with the status (the array-wrapped 403 live shape parses)", async () => {
    const t = makeTransport(() =>
      jsonResponse([{ error: { code: 403, message: "unregistered callers", status: "PERMISSION_DENIED" } }], 403),
    );
    const error = await make(t.transport).generate({ prompt: "p" }).catch((e: unknown) => e);
    expect((error as InstanceType<typeof Error>).name).toBe("GoogleImageError");
    expect((error as { status?: number }).status).toBe(403);
    expect((error as InstanceType<typeof Error>).message).toContain("HTTP 403");
  });

  it("lists image models from GET /v1beta/models — strips models/, filters the -image suffix, displayName wins", async () => {
    const t = makeTransport(() =>
      jsonResponse({
        models: [
          { name: "models/gemini-3.1-flash-image", displayName: "Gemini 3.1 Flash Image" },
          { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
          { name: "models/gemini-3-pro-image" },
          { name: "models/lyria-3.5", displayName: "Lyria" },
        ],
      }),
    );
    const models = await make(t.transport).listModels();
    expect(t.calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(models).toEqual([
      { id: "gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image" },
      { id: "gemini-3-pro-image", label: "gemini-3-pro-image" },
    ]);
  });

  it("probes with invalid-post {}: 400+API_KEY_INVALID or 403 = rejected, other 4xx = accepted, 5xx = fail", async () => {
    const invalidKey = makeTransport(() =>
      jsonResponse([
        {
          error: {
            code: 400,
            message: "API key not valid. Please pass a valid API key.",
            status: "INVALID_ARGUMENT",
            details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
          },
        },
      ], 400),
    );
    const rejected = await make(invalidKey.transport).probe();
    expect(rejected.ok).toBe(false);
    expect(rejected.detail).toContain("API key not valid");

    const unregistered = makeTransport(() =>
      jsonResponse([{ error: { code: 403, message: "unregistered callers", status: "PERMISSION_DENIED" } }], 403),
    );
    expect((await make(unregistered.transport).probe()).ok).toBe(false);

    const validationReached = makeTransport(() =>
      jsonResponse({ error: { code: 400, message: "Model is required", status: "INVALID_ARGUMENT" } }, 400),
    );
    const accepted = await make(validationReached.transport).probe();
    expect(accepted.ok).toBe(true);
    expect(accepted.detail).toContain("validation reached");

    const serverError = makeTransport(() => jsonResponse({ error: { code: 500, message: "boom" } }, 500));
    expect((await make(serverError.transport).probe()).ok).toBe(false);
  });

  it("paste tolerance: full interaction URL and /v1beta base both normalize to the bare host", async () => {
    for (const endpoint of [
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      "https://generativelanguage.googleapis.com/v1beta",
    ]) {
      const t = makeTransport(() => jsonResponse(interactionWithImages([{ data: PNG_BYTES.toString("base64") }])));
      await make(t.transport, endpoint).generate({ prompt: "p" });
      expect(t.calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    }
  });
});

// ─── Mapping seams (documented enums, deterministic) ─────────────────────────

describe("google size mapping seams", () => {
  it("mapGoogleAspectRatio: exact fraction matches and nearest-by-log-distance fallbacks", () => {
    expect(mapGoogleAspectRatio(1024, 1024)).toBe("1:1");
    expect(mapGoogleAspectRatio(1024, 576)).toBe("16:9");
    expect(mapGoogleAspectRatio(576, 1024)).toBe("9:16");
    expect(mapGoogleAspectRatio(1344, 576)).toBe("21:9");
    expect(mapGoogleAspectRatio(100, 160)).toBe("2:3"); // nearest, not exact
  });

  it("mapGoogleImageSize: nearest general tier by log distance; 512px is NEVER sent (3.1-Flash-only tier)", () => {
    expect(mapGoogleImageSize(512, 512)).toBe("1K"); // not 512px (named decision)
    expect(mapGoogleImageSize(1024, 1024)).toBe("1K");
    expect(mapGoogleImageSize(1448, 1448)).toBe("1K"); // the exact 1K/2K tie point → smaller tier
    expect(mapGoogleImageSize(1536, 1536)).toBe("2K"); // nearer 2048 than 1024 by log
    expect(mapGoogleImageSize(2048, 1152)).toBe("2K");
    expect(mapGoogleImageSize(3072, 1728)).toBe("4K"); // nearer 4096 than 2048 by log
    expect(mapGoogleImageSize(4096, 4096)).toBe("4K");
  });
});

// ─── Capability lockstep (the adapter's documented grid) ─────────────────────

describe("google capability lockstep", () => {
  it("the capability row IS the Interactions-only surface (no negative/seed/samplers; cloud, keyed)", () => {
    const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.Google];
    expect(caps.supportsNegativePrompt).toBe(false);
    expect(caps.supportsSamplers).toBe(false);
    expect(caps.supportsSeed).toBe(false);
    expect(caps.localExecution).toBe(false);
    expect(caps.noApiKey).toBe(false);
    expect(caps.sizeSupport.kind).toBe("free");
  });
});

// ─── stability (v2beta Stable Image, multipart) ─────────────────────────────

describe("stability native arm (v2beta multipart, raw bytes)", () => {
  function binaryResponse(bytes: Buffer, mimeType = "image/png"): Response {
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "Content-Type": mimeType },
    });
  }

  function make(transport: typeof fetch, endpoint = "https://api.stability.ai") {
    return createImageGenBackend(IMAGE_GEN_BACKENDS.Stability, {
      endpoint,
      apiKey: "sk-key",
      fetch: transport,
    });
  }

  function formOf(call: { init?: RequestInit }): FormData {
    const body = call.init?.body;
    if (!(body instanceof FormData)) throw new Error("expected a FormData body");
    return body;
  }

  it("routes ultra/core to their dedicated endpoints (no model field) and sd3.5-* to sd3 (model field, documented default)", async () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const cases: Array<{ model?: string; url: string; modelField: string | null }> = [
      { model: "ultra", url: "https://api.stability.ai/v2beta/stable-image/generate/ultra", modelField: null },
      { model: "core", url: "https://api.stability.ai/v2beta/stable-image/generate/core", modelField: null },
      { model: "sd3.5-flash", url: "https://api.stability.ai/v2beta/stable-image/generate/sd3", modelField: "sd3.5-flash" },
      { model: undefined, url: "https://api.stability.ai/v2beta/stable-image/generate/sd3", modelField: "sd3.5-large" },
    ];
    for (const testCase of cases) {
      const t = makeTransport(() => binaryResponse(PNG));
      await make(t.transport).generate({ prompt: "p", ...(testCase.model !== undefined ? { model: testCase.model } : {}) });
      expect(t.calls[0]?.url).toBe(testCase.url);
      const form = formOf(t.calls[0]);
      expect(form.get("model")).toBe(testCase.modelField);
    }
  });

  it("sends multipart fields: negative, nearest aspect, seed; headers Bearer + accept image/* and NO manual Content-Type", async () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const t = makeTransport(() => binaryResponse(PNG));
    const result = await make(t.transport).generate({
      prompt: "lighthouse",
      negativePrompt: "fog",
      seed: 42,
      width: 1344,
      height: 576,
      sampler: "euler",
      steps: 30,
    });
    const headers = t.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-key");
    expect(headers.accept).toBe("image/*");
    expect(headers["Content-Type"]).toBeUndefined(); // the fetch layer owns the boundary
    const form = formOf(t.calls[0]);
    expect(form.get("prompt")).toBe("lighthouse");
    expect(form.get("negative_prompt")).toBe("fog");
    expect(form.get("aspect_ratio")).toBe("21:9");
    expect(form.get("seed")).toBe("42");
    expect(form.get("style_preset")).toBeNull();
    expect(form.get("output_format")).toBeNull();
    expect(form.get("steps")).toBeNull();
    expect(form.get("sampler")).toBeNull();
    expect(result.images[0]?.mimeType).toBe("image/png"); // sniffed from magic bytes
  });

  it("cfg_scale rides ONLY the sd3 endpoint — never ultra/core", async () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const sd3 = makeTransport(() => binaryResponse(PNG));
    await make(sd3.transport).generate({ prompt: "p", model: "sd3.5-medium", cfgScale: 7 });
    expect(formOf(sd3.calls[0]).get("cfg_scale")).toBe("7");
    const core = makeTransport(() => binaryResponse(PNG));
    await make(core.transport).generate({ prompt: "p", model: "core", cfgScale: 7 });
    expect(formOf(core.calls[0]).get("cfg_scale")).toBeNull();
  });

  it("maps non-2xx to a typed error with the status; sniffs jpeg bytes", async () => {
    const t = makeTransport(() => new Response(JSON.stringify({ errors: [{ message: "bad param" }] }), { status: 400 }));
    const error = await make(t.transport).generate({ prompt: "p" }).catch((e: unknown) => e);
    expect((error as InstanceType<typeof Error>).name).toBe("StabilityImageError");
    expect((error as { status?: number }).status).toBe(400);
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const ok = makeTransport(() => new Response(new Uint8Array(JPEG), { headers: { "Content-Type": "application/octet-stream" } }));
    const result = await make(ok.transport).generate({ prompt: "p" });
    expect(result.images[0]?.mimeType).toBe("image/jpeg");
  });

  it("lists the static six-entry service catalog", async () => {
    const t = makeTransport(() => new Response("{}"));
    const models = await make(t.transport).listModels();
    expect(t.calls).toHaveLength(0); // static — no HTTP call
    expect(models.map((m) => m.id)).toEqual([
      "ultra", "core", "sd3.5-large", "sd3.5-large-turbo", "sd3.5-medium", "sd3.5-flash",
    ]);
  });

  it("probes with an empty form on core: 401/403 rejected, 400 accepted (validation reached), 500 fail", async () => {
    const unauthorized = makeTransport(() => new Response("{\"errors\":[{\"message\":\"unauthorized\"}]}", { status: 401 }));
    expect((await make(unauthorized.transport).probe()).ok).toBe(false);
    const validation = makeTransport(() => new Response("{\"errors\":[{\"message\":\"prompt is required\"}]}", { status: 400 }));
    const accepted = await make(validation.transport).probe();
    expect(accepted.ok).toBe(true);
    expect(accepted.detail).toContain("validation reached");
    const serverError = makeTransport(() => new Response("boom", { status: 500 }));
    expect((await make(serverError.transport).probe()).ok).toBe(false);
  });

  it("paste tolerance: a full service URL normalizes to the bare host", async () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const t = makeTransport(() => binaryResponse(PNG));
    await make(t.transport, "https://api.stability.ai/v2beta/stable-image/generate/core").generate({ prompt: "p", model: "core" });
    expect(t.calls[0]?.url).toBe("https://api.stability.ai/v2beta/stable-image/generate/core");
  });
});

describe("stability mapping seams", () => {
  it("mapStabilityAspectRatio: exact + nearest documented ratios", () => {
    expect(mapStabilityAspectRatio(1024, 1024)).toBe("1:1");
    expect(mapStabilityAspectRatio(1344, 576)).toBe("21:9");
    expect(mapStabilityAspectRatio(864, 1152)).toBe("4:5"); // 3:4 is NOT in stability's enum — nearest is 4:5
    expect(mapStabilityAspectRatio(1024, 576)).toBe("16:9");
  });

  it("capability lockstep: negative + seed, no samplers, cloud, keyed", () => {
    const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.Stability];
    expect(caps.supportsNegativePrompt).toBe(true);
    expect(caps.supportsSamplers).toBe(false);
    expect(caps.supportsSeed).toBe(true);
    expect(caps.localExecution).toBe(false);
    expect(caps.sizeSupport.kind).toBe("free");
  });
});
