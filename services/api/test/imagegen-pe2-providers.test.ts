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
function b64DataResponse(b64s: string[]): Response {
  return Response.json({ created: 0, data: b64s.map((b64) => ({ b64_json: b64 })) });
}

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
