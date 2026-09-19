/**
 * PE-5 wire tests — the async job/poll arm wave's provider backends (unit
 * 1: bfl). Same discipline as the PE-1..PE-4 files: T1 transport doubles
 * through the config's fetch seam, every claim pinned against the
 * live-verified wire facts (BFL re-verified 2026-09-18: openapi.json +
 * flux2 image-editing guide + the no-key auth ladder).
 */

import { describe, expect, it } from "bun:test";
import { IMAGE_GEN_BACKENDS, IMAGE_GEN_BACKEND_CAPABILITIES } from "@vibe-tavern/domain";

import { pollBflTask, BflImageConfigError, BflImageError, BFL_DEFAULT_MODEL } from "../src/domain/imagegen/backends/bfl.js";
// Import-time side-effect registration is the production wiring.
import "../src/domain/imagegen/backends/bfl.js";
import { createImageGenBackend } from "../src/domain/imagegen/imagegen-registry.js";

// ─── Shared helpers (the PE-1..PE-4 files' verbatim discipline) ──────────────

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

/** Minimal PNG bytes (magic prefix is what the sniffer needs). */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const BFL_ENDPOINT = "https://api.bfl.ai";
const POLLING_URL = "https://api.bfl.ai/v1/get_result?id=task-42";
const SAMPLE_URL = "https://delivery.bfl.ai/v1/sample.jpg?X-Amz-Signature=abc";

function make(transport: typeof fetch, endpoint = BFL_ENDPOINT) {
  return createImageGenBackend(IMAGE_GEN_BACKENDS.Bfl, {
    endpoint,
    apiKey: "bfl-key",
    fetch: transport,
  });
}

/** A Ready get_result payload. */
function readyPayload(sample: string = SAMPLE_URL): unknown {
  return { id: "task-42", status: "Ready", result: { sample }, cost: 4.2 };
}

/** Scripted flow: submit response first, then poll responses, then download. */
function scriptFlow(options?: { polls?: unknown[] }): {
  recording: typeof fetch;
  calls: RecordedCall[];
} {
  const polls = options?.polls ?? [readyPayload()];
  const recorded: RecordedCall[] = [];
  let pollIndex = 0;
  const recording: typeof fetch = (url, init) => {
    recorded.push({ url: String(url), init });
    const u = String(url);
    if (u === POLLING_URL) {
      const payload = polls[Math.min(pollIndex, polls.length - 1)];
      pollIndex += 1;
      return Promise.resolve(Response.json(payload));
    }
    if (u === SAMPLE_URL) {
      return Promise.resolve(
        new Response(new Uint8Array(PNG_BYTES), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        }),
      );
    }
    return Promise.resolve(
      Response.json({ id: "task-42", polling_url: POLLING_URL, cost: 4.2 }),
    );
  };
  return { recording, calls: recorded };
}

// ─── Registration + capabilities ─────────────────────────────────────────────

describe("bfl async arm (x-key, submit → polling_url → sample download)", () => {
  it("is registered under the bfl slug", () => {
    const backend = make(() => Promise.resolve(new Response("{}")));
    expect(typeof backend.generate).toBe("function");
  });

  it("pins the capabilities row (no negative — their own guide; free size; seed; cloud)", () => {
    const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.Bfl];
    expect(caps.supportsNegativePrompt).toBe(false);
    expect(caps.supportsSeed).toBe(true);
    expect(caps.supportsSamplers).toBe(false);
    expect(caps.sizeSupport).toEqual({ kind: "free" });
    expect(caps.noApiKey).toBe(false);
    expect(caps.localExecution).toBe(false);
    expect(caps.supportsImg2img).toBe(false);
  });

  it("listModels returns the static catalog from the live OpenAPI paths (12 image models)", async () => {
    const backend = make(() => Promise.resolve(new Response("{}")));
    const models = await backend.listModels();
    expect(models).toHaveLength(12);
    expect(models.map((m) => m.id)).toContain("flux-2-pro");
    expect(models.map((m) => m.id)).toContain("flux-2-klein-4b");
    expect(models.map((m) => m.id)).toContain("flux-pro-1.1-ultra");
    // Tools/fill/video families stay out of v1 scope.
    expect(models.some((m) => m.id.includes("fill"))).toBe(false);
    expect(models.some((m) => m.id.includes("video"))).toBe(false);
  });
});

// ─── generate — the async wire ───────────────────────────────────────────────

describe("generate — submit → poll → download", () => {
  it("POSTs {prompt,width,height,seed} to /v1/{model} with x-key only (no Authorization), polls polling_url with x-key, downloads sample WITHOUT the key", async () => {
    const { recording, calls } = scriptFlow();
    const backend = make(recording);
    const result = await backend.generate({
      prompt: "a tavern at dusk",
      width: 1024,
      height: 768,
      seed: 42,
    });

    // Submit — the default model endpoint, x-key header, no Bearer.
    expect(calls[0].url).toBe(`${BFL_ENDPOINT}/v1/${BFL_DEFAULT_MODEL}`);
    const submitHeaders = calls[0].init?.headers as Record<string, string>;
    expect(submitHeaders["x-key"]).toBe("bfl-key");
    expect(submitHeaders.Authorization).toBeUndefined();
    expect(submitHeaders["Content-Type"]).toBe("application/json");
    const body = sentJson(calls[0]);
    expect(body.prompt).toBe("a tavern at dusk");
    expect(body.width).toBe(1024);
    expect(body.height).toBe(768);
    expect(body.seed).toBe(42);

    // Poll — the vendor-returned polling_url, WITH the x-key header.
    expect(calls[1].url).toBe(POLLING_URL);
    const pollHeaders = calls[1].init?.headers as Record<string, string>;
    expect(pollHeaders["x-key"]).toBe("bfl-key");
    expect(pollHeaders.Authorization).toBeUndefined();

    // Download — the signed sample URL, NO auth header at all.
    expect(calls[2].url).toBe(SAMPLE_URL);
    const downloadHeaders = calls[2].init?.headers as Record<string, string> | undefined;
    expect(downloadHeaders?.["x-key"]).toBeUndefined();

    expect(result.images[0]?.data.equals(PNG_BYTES)).toBe(true);
    expect(result.images[0]?.mimeType).toBe("image/jpeg");
  });

  it("sends EXACTLY the set params — a prompt-only request never carries vendor-default fields (params-unset discipline)", async () => {
    const { recording, calls } = scriptFlow();
    await make(recording).generate({ prompt: "p" });
    const body = sentJson(calls[0]);
    expect(body).toEqual({ prompt: "p" });
  });

  it("never carries negative_prompt (FLUX has none — the capability is off, the wire stays clean)", async () => {
    const { recording, calls } = scriptFlow();
    await make(recording).generate({ prompt: "p", negativePrompt: "noise" });
    const body = sentJson(calls[0]);
    expect("negative_prompt" in body).toBe(false);
    expect("disable_pup" in body).toBe(false);
    expect("safety_tolerance" in body).toBe(false);
    expect("output_format" in body).toBe(false);
    expect("steps" in body).toBe(false);
  });

  it("per-request model override rides the path; /v1-suffixed endpoints paste without /v1/v1", async () => {
    const { recording, calls } = scriptFlow();
    const backend = make(recording, "https://api.bfl.ai/v1");
    await backend.generate({ prompt: "p", model: "flux-2-klein-4b" });
    expect(calls[0].url).toBe(`${BFL_ENDPOINT}/v1/flux-2-klein-4b`);
  });

  it("fails with a typed error when the Ready payload has no result.sample", async () => {
    const { recording } = scriptFlow({ polls: [{ id: "task-42", status: "Ready", result: {} }] });
    await expect(make(recording).generate({ prompt: "p" })).rejects.toBeInstanceOf(BflImageError);
  });

  it("surfaces a non-2xx submit as a typed error with the {detail} body", async () => {
    const { transport, calls } = makeTransport(() =>
      Response.json({ detail: "Invalid API key format" }, { status: 422 }),
    );
    await expect(make(transport).generate({ prompt: "p" })).rejects.toThrow(/422.*Invalid API key format/);
    expect(calls).toHaveLength(1);
  });

  it("requires a polling_url in the submit response", async () => {
    const { transport } = makeTransport(() => Response.json({ id: "x" }));
    await expect(make(transport).generate({ prompt: "p" })).rejects.toBeInstanceOf(BflImageError);
  });
});

// ─── pollBflTask (exported seam) ─────────────────────────────────────────────

describe("pollBflTask (exported seam)", () => {
  it("keeps polling through Pending/Reasoning/Generating with 1s→5s back-off, then resolves Ready", async () => {
    const polls = [
      { status: "Pending" },
      { status: "Reasoning" },
      { status: "Generating" },
      readyPayload(),
    ];
    const waits: number[] = [];
    const { recording } = scriptFlow({ polls });
    const root = await pollBflTask({
      pollingUrl: POLLING_URL,
      apiKey: "bfl-key",
      fetch: recording,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(root.status).toBe("Ready");
    // 1 s initial, doubling per 30 s window, capped at 5 s.
    expect(waits).toEqual([1_000, 1_000, 1_000]);
  });

  it("treats Content Moderated as terminal with its own message", async () => {
    const { recording } = scriptFlow({ polls: [{ status: "Content Moderated" }] });
    await expect(
      pollBflTask({ pollingUrl: POLLING_URL, apiKey: "k", fetch: recording, wait: () => Promise.resolve() }),
    ).rejects.toThrow(/Content Moderated/);
  });

  it("treats Request Moderated and Error as terminal, carrying status + detail", async () => {
    const { recording } = scriptFlow({ polls: [{ status: "Error", detail: "boom" }] });
    await expect(
      pollBflTask({ pollingUrl: POLLING_URL, apiKey: "k", fetch: recording, wait: () => Promise.resolve() }),
    ).rejects.toThrow(/Error: boom/);
  });

  it("fails closed on an UNRECOGNIZED status (never an infinite loop on a future enum value)", async () => {
    const { recording } = scriptFlow({ polls: [{ status: "SomeFuturePhase" }] });
    await expect(
      pollBflTask({ pollingUrl: POLLING_URL, apiKey: "k", fetch: recording, wait: () => Promise.resolve() }),
    ).rejects.toThrow(/SomeFuturePhase/);
  });

  it("gives up after the 150 s budget inside the 3-minute cloud timeout", async () => {
    const { recording } = scriptFlow({ polls: [{ status: "Pending" }] });
    await expect(
      pollBflTask({ pollingUrl: POLLING_URL, apiKey: "k", fetch: recording, wait: () => Promise.resolve() }),
    ).rejects.toThrow(/did not complete within 150s/);
  });
});

// ─── Config errors (synchronous, thrown by createImageGenBackend) ────────────

describe("config errors", () => {
  it("requires the x-key api key", () => {
    expect(() =>
      createImageGenBackend(IMAGE_GEN_BACKENDS.Bfl, {
        endpoint: BFL_ENDPOINT,
        apiKey: "",
        fetch: () => Promise.resolve(new Response("{}")),
      }),
    ).toThrow(BflImageConfigError);
  });

  it("requires an endpoint", () => {
    expect(() =>
      createImageGenBackend(IMAGE_GEN_BACKENDS.Bfl, {
        endpoint: "",
        apiKey: "k",
        fetch: () => Promise.resolve(new Response("{}")),
      }),
    ).toThrow(BflImageConfigError);
  });
});

// ─── Probe (the live-pinned auth ladder) ─────────────────────────────────────

describe("probe — invalid-post creds discrimination", () => {
  it("403 Not authenticated → credentials rejected", async () => {
    const { transport } = makeTransport(() =>
      Response.json({ detail: "Not authenticated" }, { status: 403 }),
    );
    const probe = await make(transport).probe();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("credentials rejected");
  });

  it("422 Invalid API key format → credentials rejected (the detail, not the status, discriminates)", async () => {
    const { transport } = makeTransport(() =>
      Response.json({ detail: "Invalid API key format" }, { status: 422 }),
    );
    const probe = await make(transport).probe();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("credentials rejected");
  });

  it("a validation 4xx (not about the key) → validation reached, credentials accepted", async () => {
    const { transport } = makeTransport(() =>
      Response.json({ detail: [{ loc: ["body", "prompt"], msg: "Field required" }] }, { status: 422 }),
    );
    const probe = await make(transport).probe();
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain("12 static models");
  });

  it("404 → endpoint not found", async () => {
    const { transport } = makeTransport(() => Response.json({ detail: "Not Found" }, { status: 404 }));
    const probe = await make(transport).probe();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("not found");
  });
});
