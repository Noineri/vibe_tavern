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
import { pollFalRequest, FalImageConfigError, FalImageError, FAL_DEFAULT_MODEL } from "../src/domain/imagegen/backends/fal.js";
import "../src/domain/imagegen/backends/fal.js";
import {
  pollReplicatePrediction,
  mapReplicateAspectRatio,
  ReplicateImageConfigError,
  ReplicateImageError,
  REPLICATE_DEFAULT_MODEL,
} from "../src/domain/imagegen/backends/replicate.js";
import "../src/domain/imagegen/backends/replicate.js";
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

// ─── fal (queue transport, Authorization: Key) ───────────────────────────────

const FAL_ENDPOINT = "https://queue.fal.run";
const FAL_STATUS_URL = "https://queue.fal.run/fal-ai/flux-2-pro/requests/req-1/status";
const FAL_RESPONSE_URL = "https://queue.fal.run/fal-ai/flux-2-pro/requests/req-1/response";
const FAL_CANCEL_URL = "https://queue.fal.run/fal-ai/flux-2-pro/requests/req-1/cancel";
const FAL_IMAGE_URL = "https://v3.fal.media/files/abc/result.png";

function makeFal(transport: typeof fetch, endpoint = FAL_ENDPOINT) {
  return createImageGenBackend(IMAGE_GEN_BACKENDS.Fal, {
    endpoint,
    apiKey: "fal-key",
    fetch: transport,
  });
}

function falSubmit(): unknown {
  return {
    request_id: "req-1",
    status_url: FAL_STATUS_URL,
    response_url: FAL_RESPONSE_URL,
    cancel_url: FAL_CANCEL_URL,
    queue_position: 3,
  };
}

function falReady(): unknown {
  return {
    status: "COMPLETED",
    response_url: FAL_RESPONSE_URL,
  };
}

function falResult(): unknown {
  return {
    images: [{ url: FAL_IMAGE_URL, width: 1024, height: 768, content_type: "image/png" }],
    seed: 9,
  };
}

/** Scripted fal flow: submit → (polls) → response → download. */
function scriptFal(options?: { statuses?: unknown[]; result?: unknown }): {
  recording: typeof fetch;
  calls: RecordedCall[];
} {
  const statuses = options?.statuses ?? [falReady()];
  const result = options?.result ?? falResult();
  const calls: RecordedCall[] = [];
  let statusIndex = 0;
  const recording: typeof fetch = (url, init) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u === FAL_STATUS_URL) {
      const payload = statuses[Math.min(statusIndex, statuses.length - 1)];
      statusIndex += 1;
      return Promise.resolve(Response.json(payload));
    }
    if (u === FAL_RESPONSE_URL) return Promise.resolve(Response.json(result));
    if (u === FAL_IMAGE_URL) {
      return Promise.resolve(
        new Response(new Uint8Array(PNG_BYTES), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      );
    }
    if (u === FAL_CANCEL_URL) return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(Response.json(falSubmit()));
  };
  return { recording, calls };
}

describe("fal queue arm (Authorization: Key, status→response→CDN download)", () => {
  it("submits {prompt,image_size,seed} with Key auth + X-Fal-Store-IO:0, polls status, fetches response, downloads the CDN image keyless, reports actual size", async () => {
    const { recording, calls } = scriptFal();
    const result = await makeFal(recording).generate({
      prompt: "a fox in the snow",
      width: 1024,
      height: 768,
      seed: 9,
    });

    // Submit — Key auth format + privacy opt-out.
    expect(calls[0].url).toBe(`${FAL_ENDPOINT}/${FAL_DEFAULT_MODEL}`);
    const submitHeaders = calls[0].init?.headers as Record<string, string>;
    expect(submitHeaders.Authorization).toBe("Key fal-key");
    expect(submitHeaders["X-Fal-Store-IO"]).toBe("0");
    const body = sentJson(calls[0]);
    expect(body.prompt).toBe("a fox in the snow");
    expect(body.image_size).toEqual({ width: 1024, height: 768 });
    expect(body.seed).toBe(9);
    expect("negative_prompt" in body).toBe(false);
    expect("num_images" in body).toBe(false);
    expect("enable_safety_checker" in body).toBe(false);
    expect("output_format" in body).toBe(false);

    // Status poll carries the same auth; response fetch too.
    expect(calls[1].url).toBe(FAL_STATUS_URL);
    expect(calls[2].url).toBe(FAL_RESPONSE_URL);
    const pollHeaders = calls[1].init?.headers as Record<string, string>;
    expect(pollHeaders.Authorization).toBe("Key fal-key");

    // Download — the signed CDN URL, no auth header.
    expect(calls[3].url).toBe(FAL_IMAGE_URL);
    const downloadHeaders = calls[3].init?.headers as Record<string, string> | undefined;
    expect(downloadHeaders?.Authorization).toBeUndefined();

    expect(result.images[0]?.data.equals(PNG_BYTES)).toBe(true);
    expect(result.width).toBe(1024);
    expect(result.height).toBe(768);
  });

  it("sends EXACTLY {prompt} on a prompt-only request (params-unset discipline)", async () => {
    const { recording, calls } = scriptFal();
    await makeFal(recording).generate({ prompt: "p" });
    expect(sentJson(calls[0])).toEqual({ prompt: "p" });
  });

  it("per-request model override rides the path (endpoint ids carry slashes)", async () => {
    const { recording, calls } = scriptFal();
    await makeFal(recording).generate({ prompt: "p", model: "fal-ai/nano-banana-2" });
    expect(calls[0].url).toBe(`${FAL_ENDPOINT}/fal-ai/nano-banana-2`);
  });

  it("surfaces the safety-checker trap as a typed error and CANCELS the request on the way out", async () => {
    const { recording, calls } = scriptFal({
      result: { images: [{ url: FAL_IMAGE_URL }], has_nsfw_concepts: [["nsfw"]] },
    });
    await expect(makeFal(recording).generate({ prompt: "p" })).rejects.toThrow(/safety checker/);
    // The cancel endpoint fired (best-effort, 204 double).
    expect(calls.some((c) => c.url === FAL_CANCEL_URL && c.init?.method === "DELETE")).toBe(true);
  });

  it("cancels on a status-poll failure too (aihorde precedent — frees the queue slot)", async () => {
    const calls: RecordedCall[] = [];
    const recording: typeof fetch = (url, init) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u === FAL_STATUS_URL) {
        return Promise.resolve(Response.json({ detail: "boom" }, { status: 500 }));
      }
      if (u === FAL_CANCEL_URL) return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(Response.json(falSubmit()));
    };
    await expect(makeFal(recording).generate({ prompt: "p" })).rejects.toThrow(/status poll failed/);
    expect(calls.some((c) => c.url === FAL_CANCEL_URL && c.init?.method === "DELETE")).toBe(true);
  });

  it("requires status_url + response_url in the submit response", async () => {
    const { transport } = makeTransport(() => Response.json({ request_id: "x" }));
    await expect(makeFal(transport).generate({ prompt: "p" })).rejects.toBeInstanceOf(FalImageError);
  });

  it("pins the capabilities row (no negative, seed, free size, cloud)", () => {
    const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.Fal];
    expect(caps.supportsNegativePrompt).toBe(false);
    expect(caps.supportsSeed).toBe(true);
    expect(caps.supportsSamplers).toBe(false);
    expect(caps.sizeSupport).toEqual({ kind: "free" });
    expect(caps.noApiKey).toBe(false);
    expect(caps.localExecution).toBe(false);
  });

  it("listModels walks the live catalog cursor pages (anonymous) and maps endpoint_id→id, display_name→label", async () => {
    const calls: RecordedCall[] = [];
    const recording: typeof fetch = (url, init) => {
      calls.push({ url: String(url), init });
      const u = new URL(String(url));
      const cursor = u.searchParams.get("cursor");
      if (cursor === null) {
        return Promise.resolve(
          Response.json({
            models: [
              { endpoint_id: "fal-ai/flux-2-pro", metadata: { display_name: "FLUX 2 Pro" } },
            ],
            next_cursor: "page-2",
            has_more: true,
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          models: [{ endpoint_id: "fal-ai/z-image/turbo", metadata: {} }],
          has_more: false,
        }),
      );
    };
    const models = await makeFal(recording).listModels();
    expect(models).toEqual([
      { id: "fal-ai/flux-2-pro", label: "FLUX 2 Pro" },
      { id: "fal-ai/z-image/turbo", label: "fal-ai/z-image/turbo" },
    ]);
    expect(calls).toHaveLength(2);
    const second = new URL(calls[1].url);
    expect(second.searchParams.get("cursor")).toBe("page-2");
    expect(second.searchParams.get("category")).toBe("text-to-image");
  });

  it("config errors are synchronous (no endpoint / no key)", () => {
    expect(() =>
      createImageGenBackend(IMAGE_GEN_BACKENDS.Fal, {
        endpoint: "",
        apiKey: "k",
        fetch: () => Promise.resolve(new Response("{}")),
      }),
    ).toThrow(FalImageConfigError);
    expect(() =>
      createImageGenBackend(IMAGE_GEN_BACKENDS.Fal, {
        endpoint: FAL_ENDPOINT,
        apiKey: "",
        fetch: () => Promise.resolve(new Response("{}")),
      }),
    ).toThrow(FalImageConfigError);
  });

  it("probe: 401 Cannot access application → credentials rejected; validation 4xx → accepted", async () => {
    const { transport } = makeTransport(() =>
      Response.json(
        { detail: "Cannot access application \"fal-ai/flux-2-pro\". Authentication is required to access this application." },
        { status: 401 },
      ),
    );
    const probe = await makeFal(transport).probe();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("credentials rejected");

    const { transport: ok } = makeTransport(() =>
      Response.json({ detail: [{ loc: ["body", "prompt"], msg: "Field required" }] }, { status: 422 }),
    );
    const okProbe = await makeFal(ok).probe();
    expect(okProbe.ok).toBe(true);
  });
});

describe("pollFalRequest (exported seam)", () => {
  it("keeps polling IN_QUEUE/IN_PROGRESS with 1s→5s back-off, resolves on COMPLETED", async () => {
    const statuses = [{ status: "IN_QUEUE", queue_position: 2 }, { status: "IN_PROGRESS" }, falReady()];
    const waits: number[] = [];
    const { recording } = scriptFal({ statuses });
    await pollFalRequest({
      statusUrl: FAL_STATUS_URL,
      apiKey: "k",
      fetch: recording,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(waits).toEqual([1_000, 1_000]);
  });

  it("fails closed on an unrecognized status", async () => {
    const { recording } = scriptFal({ statuses: [{ status: "WEIRD" }] });
    await expect(
      pollFalRequest({ statusUrl: FAL_STATUS_URL, apiKey: "k", fetch: recording, wait: () => Promise.resolve() }),
    ).rejects.toThrow(/WEIRD/);
  });

  it("gives up after the 150s budget", async () => {
    const { recording } = scriptFal({ statuses: [{ status: "IN_QUEUE" }] });
    await expect(
      pollFalRequest({ statusUrl: FAL_STATUS_URL, apiKey: "k", fetch: recording, wait: () => Promise.resolve() }),
    ).rejects.toThrow(/did not complete within 150s/);
  });
});

// ─── replicate (official-models async, Bearer, auth-gated download) ─────────

const REP_ENDPOINT = "https://api.replicate.com";
const REP_GET_URL = "https://api.replicate.com/v1/predictions/pred-1";
const REP_CANCEL_URL = "https://api.replicate.com/v1/predictions/pred-1/cancel";
const REP_IMAGE_URL = "https://replicate.delivery/xyz/result.png";

function makeRep(transport: typeof fetch, endpoint = REP_ENDPOINT) {
  return createImageGenBackend(IMAGE_GEN_BACKENDS.Replicate, {
    endpoint,
    apiKey: "r8_key",
    fetch: transport,
  });
}

function repSubmit(): unknown {
  return {
    id: "pred-1",
    status: "starting",
    urls: { get: REP_GET_URL, cancel: REP_CANCEL_URL },
  };
}

/** Scripted replicate flow: submit → (polls) → download. */
function scriptRep(options?: { polls?: unknown[]; output?: unknown }): {
  recording: typeof fetch;
  calls: RecordedCall[];
} {
  const polls = options?.polls ?? [{ id: "pred-1", status: "succeeded", output: [REP_IMAGE_URL] }];
  const calls: RecordedCall[] = [];
  let pollIndex = 0;
  const recording: typeof fetch = (url, init) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u === REP_GET_URL) {
      const payload = polls[Math.min(pollIndex, polls.length - 1)];
      pollIndex += 1;
      return Promise.resolve(Response.json(payload));
    }
    if (u === REP_IMAGE_URL) {
      return Promise.resolve(
        new Response(new Uint8Array(PNG_BYTES), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      );
    }
    if (u === REP_CANCEL_URL) return Promise.resolve(new Response(null, { status: 201 }));
    return Promise.resolve(Response.json(repSubmit()));
  };
  return { recording, calls };
}

describe("replicate official-models arm (Bearer, {input}, auth-gated download)", () => {
  it("POSTs {input:{prompt,aspect_ratio,seed}} to /v1/models/{owner}/{model}/predictions, polls urls.get, downloads WITH the Bearer key", async () => {
    const { recording, calls } = scriptRep();
    const result = await makeRep(recording).generate({
      prompt: "a lantern",
      width: 1920,
      height: 1080,
      seed: 5,
    });

    // Submit — official-models path, {input} envelope, Bearer auth.
    expect(calls[0].url).toBe(`${REP_ENDPOINT}/v1/models/${REPLICATE_DEFAULT_MODEL}/predictions`);
    const submitHeaders = calls[0].init?.headers as Record<string, string>;
    expect(submitHeaders.Authorization).toBe("Bearer r8_key");
    const body = sentJson(calls[0]);
    expect(body.input).toEqual({ prompt: "a lantern", aspect_ratio: "16:9", seed: 5 });
    expect("negative_prompt" in body.input).toBe(false);
    expect("num_outputs" in body.input).toBe(false);
    expect("megapixels" in body.input).toBe(false);
    expect("disable_safety_checker" in body.input).toBe(false);

    // Poll the returned urls.get; download WITH the key (the card's trap).
    expect(calls[1].url).toBe(REP_GET_URL);
    expect(calls[2].url).toBe(REP_IMAGE_URL);
    const downloadHeaders = calls[2].init?.headers as Record<string, string>;
    expect(downloadHeaders.Authorization).toBe("Bearer r8_key");

    expect(result.images[0]?.data.equals(PNG_BYTES)).toBe(true);
  });

  it("maps W×H onto the ratio grid exact-else-nearest (1024x1024 exact; 1000x3000 nearest 9:21; unset stays unset)", () => {
    expect(mapReplicateAspectRatio(1024, 1024)).toBe("1:1");
    expect(mapReplicateAspectRatio(1920, 1080)).toBe("16:9");
    expect(mapReplicateAspectRatio(1000, 3000)).toBe("9:21");
    expect(mapReplicateAspectRatio(999, 1001)).toBe("1:1");
    expect(mapReplicateAspectRatio(undefined, 512)).toBeUndefined();
    expect(mapReplicateAspectRatio(512, undefined)).toBeUndefined();
  });

  it("a prompt-only request sends EXACTLY {input:{prompt}} (params-unset discipline)", async () => {
    const { recording, calls } = scriptRep();
    await makeRep(recording).generate({ prompt: "p" });
    expect(sentJson(calls[0])).toEqual({ input: { prompt: "p" } });
  });

  it("accepts a bare-string output (single-output models) as well as the URI array", async () => {
    const { recording, calls } = scriptRep({
      polls: [{ id: "pred-1", status: "succeeded", output: REP_IMAGE_URL }],
    });
    const result = await makeRep(recording).generate({ prompt: "p" });
    expect(result.images[0]?.data.equals(PNG_BYTES)).toBe(true);
  });

  it("null output (the 1-hour removal) is a typed error naming the trap", async () => {
    const { recording } = scriptRep({ polls: [{ id: "pred-1", status: "succeeded", output: null }] });
    await expect(makeRep(recording).generate({ prompt: "p" })).rejects.toThrow(/no output URL/);
  });

  it("cancels via POST urls.cancel on a poll failure and carries the vendor error field", async () => {
    const calls: RecordedCall[] = [];
    const recording: typeof fetch = (url, init) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u === REP_GET_URL) {
        return Promise.resolve(Response.json({ id: "pred-1", status: "failed", error: "OOM on GPU" }));
      }
      if (u === REP_CANCEL_URL) return Promise.resolve(new Response(null, { status: 201 }));
      return Promise.resolve(Response.json(repSubmit()));
    };
    await expect(makeRep(recording).generate({ prompt: "p" })).rejects.toThrow(/failed: OOM on GPU/);
    expect(calls.some((c) => c.url === REP_CANCEL_URL && c.init?.method === "POST")).toBe(true);
  });

  it("listModels rides the AUTHED t2i collection (the 2026-09-18 public-list drift)", async () => {
    const calls: RecordedCall[] = [];
    const recording: typeof fetch = (url, init) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(
        Response.json({
          name: "Text to image",
          slug: "text-to-image",
          models: [
            { owner: "black-forest-labs", name: "flux-schnell", description: "fast" },
            { owner: "stability-ai", name: "sdxl", description: "sdxl" },
          ],
        }),
      );
    };
    const models = await makeRep(recording).listModels();
    expect(calls[0].url).toBe(`${REP_ENDPOINT}/v1/collections/text-to-image`);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer r8_key");
    expect(models).toEqual([
      { id: "black-forest-labs/flux-schnell", label: "flux-schnell" },
      { id: "stability-ai/sdxl", label: "sdxl" },
    ]);
  });

  it("pins the capabilities row (no negative, seed, free size + ratio mapping, cloud)", () => {
    const caps = IMAGE_GEN_BACKEND_CAPABILITIES[IMAGE_GEN_BACKENDS.Replicate];
    expect(caps.supportsNegativePrompt).toBe(false);
    expect(caps.supportsSeed).toBe(true);
    expect(caps.supportsSamplers).toBe(false);
    expect(caps.sizeSupport).toEqual({ kind: "free" });
    expect(caps.noApiKey).toBe(false);
    expect(caps.localExecution).toBe(false);
  });

  it("config errors are synchronous (no endpoint / no key)", () => {
    expect(() =>
      createImageGenBackend(IMAGE_GEN_BACKENDS.Replicate, {
        endpoint: "",
        apiKey: "k",
        fetch: () => Promise.resolve(new Response("{}")),
      }),
    ).toThrow(ReplicateImageConfigError);
    expect(() =>
      createImageGenBackend(IMAGE_GEN_BACKENDS.Replicate, {
        endpoint: REP_ENDPOINT,
        apiKey: "",
        fetch: () => Promise.resolve(new Response("{}")),
      }),
    ).toThrow(ReplicateImageConfigError);
  });

  it("probe: both live 401 shapes → credentials rejected; validation 4xx → accepted", async () => {
    for (const detail of [
      "You did not pass an authentication token",
      "Invalid or expired API token.",
    ]) {
      const { transport } = makeTransport(() =>
        Response.json({ title: "Unauthenticated", detail }, { status: 401 }),
      );
      const probe = await makeRep(transport).probe();
      expect(probe.ok).toBe(false);
      expect(probe.detail).toContain("credentials rejected");
    }
    const { transport: ok } = makeTransport(() =>
      Response.json({ detail: "Input is invalid" }, { status: 422 }),
    );
    const okProbe = await makeRep(ok).probe();
    expect(okProbe.ok).toBe(true);
  });
});

describe("pollReplicatePrediction (exported seam)", () => {
  it("keeps polling starting/processing with 1s→5s back-off, resolves on succeeded", async () => {
    const waits: number[] = [];
    const polls = [
      { status: "starting" },
      { status: "processing" },
      { status: "succeeded", output: [REP_IMAGE_URL] },
    ];
    const { recording } = scriptRep({ polls });
    await pollReplicatePrediction({
      getUrl: REP_GET_URL,
      apiKey: "k",
      fetch: recording,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(waits).toEqual([1_000, 1_000]);
  });

  it("treats canceled as terminal with its own message", async () => {
    const { recording } = scriptRep({ polls: [{ status: "canceled" }] });
    await expect(
      pollReplicatePrediction({ getUrl: REP_GET_URL, apiKey: "k", fetch: recording, wait: () => Promise.resolve() }),
    ).rejects.toThrow(/canceled/);
  });

  it("gives up after the 150s budget", async () => {
    const { recording } = scriptRep({ polls: [{ status: "processing" }] });
    await expect(
      pollReplicatePrediction({ getUrl: REP_GET_URL, apiKey: "k", fetch: recording, wait: () => Promise.resolve() }),
    ).rejects.toThrow(/did not complete within 150s/);
  });
});
