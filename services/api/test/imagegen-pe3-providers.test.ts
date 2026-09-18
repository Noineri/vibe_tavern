/**
 * Wave PE-3 provider wire tests (IMAGEGEN_PROVIDER_EXPANSION_PLAN) — the
 * raw-binary arm and its three riders: the pollinations legacy GET tier
 * (dispatched by baseUrl host through the SAME slug as the unified
 * gateway), chutes per-chute hosts, and the Hugging Face router.
 *
 * Card facts (doc-verified 2026-09-07, re-verified 2026-09-18) + live
 * probes the same day: pollinations anonymous generation 200 image/jpeg
 * (both flux and sana) post-gateway-launch; GET /models → ["sana"] bare
 * array (under-reports); chutes z-image-turbo POST without key → 401 +
 * per-chute llms.txt schema pinned; hf router POST → 401 unauth and the
 * Hub picker sort drift (trending → trendingScore).
 *
 * Tier policy: T1 — every HTTP call goes through the injected fetch
 * double (ImageGenAdapterConfig.fetch), no mock.module, no globals.
 */

import { describe, expect, it } from "bun:test";

import { IMAGE_GEN_BACKENDS, IMAGE_GEN_BACKEND_CAPABILITIES } from "@vibe-tavern/domain";

import { createImageGenBackend } from "../src/domain/imagegen/imagegen-registry.js";
// Import-time side-effect registrations are the production wiring — the
// family module registers the unified rows + the pollinations two-tier
// dispatcher; raw-binary registers chutes/hf.
import "../src/domain/imagegen/backends/openai-images-family.js";
import "../src/domain/imagegen/backends/raw-binary.js";

// ─── Test doubles (the PE-2 helpers, mirrored) ───────────────────────────────

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

/** fetch double: records every call, answers from the scripted handler. */
function makeTransport(
  answer: (call: RecordedCall) => Response | Promise<Response>,
): { transport: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport: typeof fetch = (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { transport, calls };
}

/** Decode the JSON body a recorded call sent. */
function sentJson(call: RecordedCall): Record<string, unknown> {
  const body = call.init?.body;
  if (typeof body !== "string") throw new Error(`expected a string body, got ${typeof body}`);
  return JSON.parse(body) as Record<string, unknown>;
}

/** Minimal 1×1 transparent PNG. */
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cfc00000030101006b04e7a50000000049454e44ae426082",
  "hex",
);

/** Minimal 1×1 JPEG (the legacy tier's observed content type). */
const JPEG_BYTES = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffd9",
  "hex",
);

function binaryResponse(bytes: Buffer, contentType: string): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

// ─── Pollinations legacy tier (PE-3 unit 1) ─────────────────────────────────

const LEGACY_BASE = "https://image.pollinations.ai";
const UNIFIED_BASE = "https://gen.pollinations.ai/v1";

describe("pollinations legacy tier (raw-binary GET, zero-config)", () => {
  const make = (transport: typeof fetch, endpoint = LEGACY_BASE, apiKey?: string) =>
    createImageGenBackend(IMAGE_GEN_BACKENDS.Pollinations, {
      endpoint,
      ...(apiKey !== undefined ? { apiKey } : {}),
      fetch: transport,
    });

  it("generates via GET /prompt/{encoded} with model/width/height only — no seed (per-tier caps named decision), no body", async () => {
    const { transport, calls } = makeTransport(() =>
      binaryResponse(JPEG_BYTES, "image/jpeg"),
    );
    const backend = make(transport);
    const result = await backend.generate({
      prompt: "таверна в сумерках",
      model: "flux",
      width: 640,
      height: 960,
      seed: 42, // documented on the legacy tier — deliberately NOT wired
      negativePrompt: "blurry", // no surface — dropped
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.body).toBeUndefined();
    const url = new URL(calls[0].url);
    expect(url.origin).toBe(LEGACY_BASE);
    expect(url.pathname).toBe("/prompt/%D1%82%D0%B0%D0%B2%D0%B5%D1%80%D0%BD%D0%B0%20%D0%B2%20%D1%81%D1%83%D0%BC%D0%B5%D1%80%D0%BA%D0%B0%D1%85");
    expect(url.searchParams.get("model")).toBe("flux");
    expect(url.searchParams.get("width")).toBe("640");
    expect(url.searchParams.get("height")).toBe("960");
    expect(url.searchParams.get("seed")).toBeNull();
    expect(url.searchParams.has("nologo")).toBe(false);
    expect(result.images[0].data.equals(JPEG_BYTES)).toBe(true);
    expect(result.images[0].mimeType).toBe("image/jpeg");
    expect(result.width).toBe(640);
    expect(result.height).toBe(960);
  });

  it("sends no Authorization header without a key, Bearer with one (optional tier)", async () => {
    const bare = makeTransport(() => binaryResponse(JPEG_BYTES, "image/jpeg"));
    await make(bare.transport).generate({ prompt: "p" });
    const headersBare = bare.calls[0].init?.headers as Record<string, string> | undefined;
    expect(headersBare?.Authorization).toBeUndefined();

    const keyed = makeTransport(() => binaryResponse(JPEG_BYTES, "image/jpeg"));
    await make(keyed.transport, LEGACY_BASE, "pk-key").generate({ prompt: "p" });
    const headersKeyed = keyed.calls[0].init?.headers as Record<string, string>;
    expect(headersKeyed.Authorization).toBe("Bearer pk-key");
  });

  it("sniffs the MIME from magic bytes when the content-type is missing or lies", async () => {
    const sniffed = makeTransport(
      () => new Response(new Uint8Array(PNG_BYTES), { status: 200 }), // no content-type
    );
    const result = await make(sniffed.transport).generate({ prompt: "p" });
    expect(result.images[0].mimeType).toBe("image/png");

    const lying = makeTransport(() =>
      binaryResponse(JPEG_BYTES, "application/octet-stream"),
    );
    const result2 = await make(lying.transport).generate({ prompt: "p" });
    expect(result2.images[0].mimeType).toBe("image/jpeg");
  });

  it("surfaces a 200 non-image payload as a typed error (not a corrupt image)", async () => {
    const html = makeTransport(() =>
      new Response("<html>rate limited</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(make(html.transport).generate({ prompt: "p" })).rejects.toThrow(
      /non-image payload/,
    );
  });

  it("maps non-2xx to a typed error with status; 202 to the async-not-supported error", async () => {
    const rateLimited = makeTransport(
      () => new Response("too many requests", { status: 429 }),
    );
    await expect(make(rateLimited.transport).generate({ prompt: "p" })).rejects.toThrow(
      /HTTP 429/,
    );
    const accepted = makeTransport(() => new Response(null, { status: 202 }));
    await expect(make(accepted.transport).generate({ prompt: "p" })).rejects.toThrow(
      /202 \(async job\)/,
    );
  });

  it("lists models from the documented bare-string-array endpoint, verbatim", async () => {
    const { transport, calls } = makeTransport(() => Response.json(["sana"]));
    const models = await make(transport).listModels();
    expect(models).toEqual([{ id: "sana", label: "sana" }]);
    expect(calls[0].url).toBe(`${LEGACY_BASE}/models`);
  });

  it("probes anonymously: 200 = ok (no key required), 429 = ok with the rate-limit note, 500 = fail", async () => {
    const ok = makeTransport(() => Response.json(["sana"]));
    expect(await make(ok.transport).probe()).toEqual({
      ok: true,
      detail: "anonymous tier reachable — no key required (rate-limited)",
    });

    const throttled = makeTransport(() => new Response("slow down", { status: 429 }));
    const throttledResult = await make(throttled.transport).probe();
    expect(throttledResult.ok).toBe(true);
    expect(throttledResult.detail).toContain("rate limit");

    const down = makeTransport(() => new Response("boom", { status: 500 }));
    const downResult = await make(down.transport).probe();
    expect(downResult.ok).toBe(false);
  });

  it("keeps the UNIFIED tier on the family row (same slug, gen.* host stays POST /v1/images/generations)", async () => {
    const { transport, calls } = makeTransport(() =>
      Response.json({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }),
    );
    const backend = make(transport, UNIFIED_BASE, "pk-key");
    await backend.generate({ prompt: "p", model: "nanobanana-2" });
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].url).toBe(`${UNIFIED_BASE}/images/generations`);
    const body = sentJson(calls[0]);
    expect(body.model).toBe("nanobanana-2");
  });
});
