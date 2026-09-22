/**
 * IPT-3 family detection ladder (IMAGE_PROMPT_TEMPLATES_PLAN Wave 3.4) —
 * the strict source order with every miss/error recorded in tried[]:
 * backend-native metadata → sidecars next to a backend-exposed path →
 * Civitai public by-hash (with the SDXL author-tag disambiguation) → the
 * Prompt All-in-One extension preset. Pure T1 doubles: the backend object,
 * the Civitai transport, and the sidecar read are all injected stubs (no
 * mock.module, no globalThis patching, no live network). The domain-level
 * label mapping itself is pinned in
 * packages/domain/test/image-prompt-families.test.ts.
 */

// hygiene:allow-abs-path-inputs — the stubbed backends/report absolute model
// paths (drive-letter server paths, exactly what sd-models `filename` and the
// extension `filepath` carry in production); they are quoted RESPONSE DATA
// and stub expectations, never files this test reads from disk.

import { describe, expect, test } from "bun:test";

import {
  detectImageGenFamily,
  FAMILY_DETECTION_SOURCES,
  type FamilyDetectionBackend,
  type FamilyDetectionDeps,
  type FamilyDetectionResult,
} from "../src/domain/imagegen/family-detection.js";
import type { ImageGenModelDetectionMetadata } from "../src/domain/imagegen/imagegen-backend.js";
import { a1111Factory } from "../src/domain/imagegen/backends/a1111.js";
import { comfyImageGenFactory } from "../src/domain/imagegen/backends/comfyui.js";

/** A fetch double over an in-memory URL router (path prefix → JSON body or
 *  status). Unmatched URLs 404 — an honest miss, never a throw. */
function civitaiStub(routes: Record<string, unknown>): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    const key = `${url.pathname}${url.search}`;
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.origin === "https://civitai.com" && key.startsWith(prefix)) {
        return Response.json(body);
      }
    }
    return new Response("nope", { status: 404 });
  };
}

/** Every Civitai request this transport saw (path + headers) — the
 *  User-Agent pin below reads these. */
function civitaiRecorder(): { fetch: typeof fetch; seen: Array<{ path: string; userAgent?: string; accept?: string }> } {
  const seen: Array<{ path: string; userAgent?: string; accept?: string }> = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = ((init?.headers ?? {}) as Record<string, string>);
    if (url.origin === "https://civitai.com") {
      seen.push({ path: url.pathname, userAgent: headers["User-Agent"], accept: headers.Accept });
    }
    return new Response("nope", { status: 404 });
  };
  return { fetch: transport, seen };
}

/** The minimal backend surface detectImageGenFamily reads (tier T1 — a
 *  plain object, visible in the type signature). */
function fakeBackend(metadata: ImageGenModelDetectionMetadata): FamilyDetectionBackend {
  return {
    readModelDetectionMetadata: async () => metadata,
  };
}

function makeDeps(
  sidecars: Record<string, string> = {},
  civitai: typeof fetch = civitaiStub({}),
): FamilyDetectionDeps {
  return {
    civitaiFetch: civitai,
    readSidecarFile: async (path) => sidecars[path],
  };
}

function run(
  metadata: ImageGenModelDetectionMetadata,
  deps: FamilyDetectionDeps,
  extra?: FamilyDetectionBackend,
): Promise<FamilyDetectionResult> {
  const backend: FamilyDetectionBackend = { ...fakeBackend(metadata), ...extra };
  return detectImageGenFamily({ backend, model: "model.safetensors", deps });
}

describe("family detection — source (a): backend-native metadata", () => {
  test("an embedded base-model label hits directly and short-circuits every later source", async () => {
    const civitaiCalls: string[] = [];
    const sidecarReads: string[] = [];
    const deps: FamilyDetectionDeps = {
      civitaiFetch: async (input) => {
        civitaiCalls.push(String(input));
        return new Response("nope", { status: 404 });
      },
      readSidecarFile: async (path) => {
        sidecarReads.push(path);
        return undefined;
      },
    };
    const result = await run({ baseModel: "NoobAI-XL VPred 0.6", sidecar: { roots: ["/models/checkpoints"], relativeName: "model.safetensors" } }, deps);
    expect(result).toEqual({
      ok: true,
      family: "noobai",
      sourceLabel: FAMILY_DETECTION_SOURCES.BackendMetadata,
      baseModel: "NoobAI-XL VPred 0.6",
    });
    expect(civitaiCalls).toEqual([]);
    expect(sidecarReads).toEqual([]);
  });

  test("a backend without the metadata surface records the structural miss", async () => {
    const backend: FamilyDetectionBackend = {};
    const result = await detectImageGenFamily({
      backend,
      model: "model.safetensors",
      deps: makeDeps(),
    });
    expect(result).toEqual({
      ok: false,
      error: "No authoritative source identified this model's family — set it manually in the profile.",
      tried: [
        { source: "backend-metadata", reason: "this backend dialect exposes no native model-metadata surface" },
        { source: "sidecar", reason: "no authoritative model path was exposed to join sidecars against" },
        { source: "civitai-by-hash", reason: "no model hash available from an authoritative source" },
        { source: "extension-preset", reason: "this backend dialect has no model-preset extension surface" },
      ],
    });
  });

  test("an SDXL-class embedded label stays ambiguous at this source and the ladder continues", async () => {
    // Embedded says plain SDXL (architecture truth) — the sidecar owns the
    // lineage label; the corpus-less SDXL answer must not guess.
    const result = await run(
      { baseModel: "SDXL 1.0", sidecar: { roots: ["/ckpt"], relativeName: "model.safetensors" } },
      makeDeps({ "/ckpt/model.civitai.info": JSON.stringify({ baseModel: "Pony" }) }),
    );
    expect(result).toEqual({
      ok: true,
      family: "pony",
      sourceLabel: FAMILY_DETECTION_SOURCES.Sidecar,
      baseModel: "Pony",
    });
  });

  test("a reader failure is recorded, not swallowed — and the ladder continues", async () => {
    const backend: FamilyDetectionBackend = {
      readModelDetectionMetadata: async () => {
        throw new Error("A1111 model list failed with HTTP 500");
      },
    };
    const result = await detectImageGenFamily({ backend, model: "m", deps: makeDeps() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tried[0]).toEqual({
        source: "backend-metadata",
        reason: "backend metadata read failed: A1111 model list failed with HTTP 500",
      });
      expect(result.tried).toHaveLength(4);
    }
  });

  test("the caller's abort propagates untouched", async () => {
    const backend: FamilyDetectionBackend = {
      readModelDetectionMetadata: async () => {
        throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      },
    };
    await expect(
      detectImageGenFamily({ backend, model: "m", deps: makeDeps() }),
    ).rejects.toThrow();
  });
});

describe("family detection — source (b): sidecars next to the exposed path", () => {
  test(".cm-info.json precedes .civitai.info (CG-A3 precedence) and the stem rule strips weights extensions", async () => {
    const reads: string[] = [];
    const deps: FamilyDetectionDeps = {
      civitaiFetch: civitaiStub({}),
      readSidecarFile: async (path) => {
        reads.push(path);
        if (path === "/ckpt/sub/model.cm-info.json") return JSON.stringify({ BaseModel: "Illustrious" });
        return undefined;
      },
    };
    const result = await run({ sidecar: { roots: ["/ckpt"], relativeName: "sub/model.safetensors" } }, deps);
    expect(result).toEqual({
      ok: true,
      family: "illustrious",
      sourceLabel: FAMILY_DETECTION_SOURCES.Sidecar,
      baseModel: "Illustrious",
    });
    expect(reads[0]).toBe("/ckpt/sub/model.cm-info.json");
  });

  test("all candidate sidecars missing → honest miss; an unmapped sidecar label misses too", async () => {
    const miss = await run({ sidecar: { roots: ["/ckpt"], relativeName: "model.safetensors" } }, makeDeps());
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.tried[1]).toEqual({
        source: "sidecar",
        reason: "no readable .cm-info.json / .civitai.info sidecar next to the model",
      });
    }
    const unmapped = await run(
      { sidecar: { roots: ["/ckpt"], relativeName: "model.safetensors" } },
      makeDeps({ "/ckpt/model.civitai.info": JSON.stringify({ baseModel: "SD 1.5" }) }),
    );
    expect(unmapped.ok).toBe(false);
    if (!unmapped.ok) {
      expect(unmapped.tried[1]?.reason).toContain("base model 'SD 1.5' has no registry family mapping");
    }
  });
});

describe("family detection — source (c): Civitai public by-hash", () => {
  test("a by-hash baseModel hit resolves the family", async () => {
    const result = await run(
      { sha256: "a".repeat(64) },
      makeDeps({}, civitaiStub({ "/api/v1/model-versions/by-hash/": { baseModel: "Pony", modelId: 1 } })),
    );
    expect(result).toEqual({
      ok: true,
      family: "pony",
      sourceLabel: FAMILY_DETECTION_SOURCES.CivitaiByHash,
      baseModel: "Pony",
    });
  });

  test("SDXL 1.0 + realism author tags → sdxl-realism (the model follow-up carries the corpus)", async () => {
    const result = await run(
      { sha256: "b".repeat(64) },
      makeDeps(
        {},
        civitaiStub({
          "/api/v1/model-versions/by-hash/": { baseModel: "SDXL 1.0", modelId: 77 },
          "/api/v1/models/77": { tags: ["photorealistic", "portrait photography"] },
        }),
      ),
    );
    expect(result).toEqual({
      ok: true,
      family: "sdxl-realism",
      sourceLabel: FAMILY_DETECTION_SOURCES.CivitaiByHash,
      baseModel: "SDXL 1.0",
    });
  });

  test("SDXL 1.0 + anime tags refuses to guess — the miss records the ambiguity and the ladder continues", async () => {
    const result = await run(
      { sha256: "c".repeat(64), modelFilePath: "C:/models/model.safetensors" },
      makeDeps(
        {},
        civitaiStub({
          "/api/v1/model-versions/by-hash/": { baseModel: "SDXL 1.0", modelId: 88 },
          "/api/v1/models/88": { tags: ["anime", "style"] },
        }),
      ),
      { readModelPresetFromExtension: async () => ({ baseModel: "Anima" }) },
    );
    // The extension source answers after the ambiguous corpus.
    expect(result).toEqual({
      ok: true,
      family: "anima",
      sourceLabel: FAMILY_DETECTION_SOURCES.ExtensionPreset,
      baseModel: "Anima",
    });
  });

  test("a 404 by-hash (unknown hash) and a transport failure are recorded misses, never guesses", async () => {
    const notFound = await run({ sha256: "d".repeat(64) }, makeDeps());
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) {
      expect(notFound.tried[2]).toEqual({
        source: "civitai-by-hash",
        reason: "Civitai by-hash lookup failed (HTTP 404)",
      });
    }
    const offline = await run(
      { sha256: "e".repeat(64) },
      makeDeps({}, async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );
    expect(offline.ok).toBe(false);
    if (!offline.ok) {
      expect(offline.tried[2]?.reason).toBe("Civitai by-hash lookup failed: connect ECONNREFUSED");
    }
  });

  test("EVERY Civitai GET carries the source-proven browser User-Agent (Cloudflare 1010 guard)", async () => {
    // The SDXL flow exercises BOTH requests (by-hash + the model tag
    // corpus follow-up); the recorder pins each one's headers.
    const recorder = civitaiRecorder();
    const civitai: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = ((init?.headers ?? {}) as Record<string, string>);
      if (url.origin === "https://civitai.com") {
        recorder.seen.push({ path: url.pathname, userAgent: headers["User-Agent"], accept: headers.Accept });
      }
      if (url.pathname.startsWith("/api/v1/model-versions/by-hash/")) {
        return Response.json({ baseModel: "SDXL 1.0", modelId: 77 });
      }
      if (url.pathname === "/api/v1/models/77") {
        return Response.json({ tags: ["photorealistic"] });
      }
      return new Response("nope", { status: 404 });
    };
    const result = await run({ sha256: "g".repeat(64) }, makeDeps({}, civitai));
    expect(result).toEqual({
      ok: true,
      family: "sdxl-realism",
      sourceLabel: FAMILY_DETECTION_SOURCES.CivitaiByHash,
      baseModel: "SDXL 1.0",
    });
    expect(recorder.seen.map((call) => call.path)).toEqual([
      `/api/v1/model-versions/by-hash/${"g".repeat(64)}`,
      "/api/v1/models/77",
    ]);
    for (const call of recorder.seen) {
      expect(call.userAgent).toMatch(/^Mozilla\/5\.0 \(Windows NT 10\.0;/);
      expect(call.accept).toBe("application/json");
    }
  });
});

describe("family detection — source (d): the extension preset", () => {
  test("a non-empty Civitai-resolved base_model answers after all earlier sources miss", async () => {
    const calls: string[] = [];
    const result = await run(
      { sha256: "f".repeat(64), modelFilePath: "C:/models/model.safetensors" },
      makeDeps(),
      {
        readModelPresetFromExtension: async (filepath) => {
          calls.push(filepath);
          return { baseModel: "Qwen-Image" };
        },
      },
    );
    expect(result).toEqual({
      ok: true,
      family: "qwen",
      sourceLabel: FAMILY_DETECTION_SOURCES.ExtensionPreset,
      baseModel: "Qwen-Image",
    });
    expect(calls).toEqual(["C:/models/model.safetensors"]);
  });

  test("an empty base_model (the extension's filename-preset machinery) is a miss, never a guess", async () => {
    const result = await run(
      { modelFilePath: "C:/models/model.safetensors" },
      makeDeps(),
      { readModelPresetFromExtension: async () => ({ baseModel: "" }) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tried[3]).toEqual({
        source: "extension-preset",
        reason: "the extension returned no Civitai-resolved base model",
      });
      expect(result.tried).toHaveLength(4);
    }
  });

  test("no model file path → the probe is skipped with the honest reason", async () => {
    const result = await run({}, makeDeps(), { readModelPresetFromExtension: async () => ({}) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tried[3]).toEqual({
        source: "extension-preset",
        reason: "no authoritative model file path to hand the extension",
      });
    }
  });
});

describe("family detection — ambiguous labels never resolve (the no-guess rule)", () => {
  test("a backend-metadata label naming NoobAI+Illustrious is an honest miss, never a pick", async () => {
    const result = await run({ baseModel: "NoobAI Illustrious" }, makeDeps());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tried[0]).toEqual({
        source: "backend-metadata",
        reason:
          "base model 'NoobAI Illustrious' matches multiple families (noobai, illustrious) — set the family manually",
      });
    }
  });

  test("a sidecar label naming Pony+Anima is an honest miss too", async () => {
    const result = await run(
      { sidecar: { roots: ["/ckpt"], relativeName: "model.safetensors" } },
      makeDeps({ "/ckpt/model.civitai.info": JSON.stringify({ baseModel: "Pony Anima" }) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tried[1]?.reason).toContain("matches multiple families (anima, pony)");
    }
  });
});

describe("family detection — real backend readers (failure honesty)", () => {
  // The a1111/comfy factories through their fetch seam (tier T1) — these
  // pin that the DETECTION readers surface real failure reasons into the
  // ladder's tried[] instead of collapsing them to empty misses. Listing
  // behavior (the silent-degradation helpers) is untouched and pinned by
  // the imagegen-a1111/imagegen-comfy suites.

  test("a1111 extension probe: non-2xx throws the typed reason and the ladder records it at source (d)", async () => {
    const backend = a1111Factory({
      endpoint: "http://127.0.0.1:7860",
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/sd-models")) {
          return Response.json([
            { title: "m", model_name: "m", hash: "aaa", sha256: "", filename: "X:/ckpt/m.safetensors", config: "" },
          ]);
        }
        return new Response("boom", { status: 500 });
      },
    });
    const result = await detectImageGenFamily({ backend, model: "m", deps: makeDeps() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tried[3]).toEqual({
        source: "extension-preset",
        reason: "extension preset detection failed: A1111 model preset detection failed with HTTP 500: boom",
      });
    }
  });

  test("a1111 extension probe: transport error throws (wrapped); 200+empty base_model stays the empty result", async () => {
    const offline = a1111Factory({
      endpoint: "http://127.0.0.1:7860",
      fetch: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    await expect(offline.readModelPresetFromExtension!("X:/ckpt/m.safetensors")).rejects.toThrow(
      "network error",
    );
    const empty = a1111Factory({
      endpoint: "http://127.0.0.1:7860",
      fetch: async () => Response.json({ source: "preset", base_model: "" }),
    });
    await expect(empty.readModelPresetFromExtension!("X:/ckpt/m.safetensors")).resolves.toEqual({});
  });

  test("comfy reader: a failed folder map records its HTTP reason at source (b), not the structural text", async () => {
    const backend = comfyImageGenFactory({
      endpoint: "http://127.0.0.1:8188",
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/models/checkpoints") return Response.json(["m.safetensors"]);
        if (url.pathname === "/models/diffusion_models") return Response.json([]);
        if (url.pathname === "/view_metadata/checkpoints") return new Response("nope", { status: 404 });
        if (url.pathname === "/internal/folder_paths") return new Response("err", { status: 500 });
        return new Response("nope", { status: 404 });
      },
    });
    const result = await detectImageGenFamily({ backend, model: "m.safetensors", deps: makeDeps() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // view_metadata 404 = the honest no-label miss (the installed core
      // 404s when the header carries no __metadata__).
      expect(result.tried[0]).toEqual({
        source: "backend-metadata",
        reason: "the backend's metadata surface carried no base-model label",
      });
      expect(result.tried[1]).toEqual({
        source: "sidecar",
        reason: "ComfyUI folder map failed with HTTP 500: err",
      });
    }
  });

  test("comfy reader: an embedded-metadata failure is carried at source (a) while the folder-map anchor survives for (b)", async () => {
    const backend = comfyImageGenFactory({
      endpoint: "http://127.0.0.1:8188",
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/models/checkpoints") return Response.json(["m.safetensors"]);
        if (url.pathname === "/models/diffusion_models") return Response.json([]);
        if (url.pathname === "/view_metadata/checkpoints") return new Response("err", { status: 500 });
        if (url.pathname === "/internal/folder_paths") {
          return Response.json({ checkpoints: ["R:/ckpt"] });
        }
        return new Response("nope", { status: 404 });
      },
    });
    const result = await detectImageGenFamily({ backend, model: "m.safetensors", deps: makeDeps() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tried[0]).toEqual({
        source: "backend-metadata",
        reason: "backend metadata read failed: ComfyUI model metadata failed with HTTP 500: err",
      });
      // The anchor survived: (b) attempted the real sidecar paths (the
      // read miss, not the structural no-path text).
      expect(result.tried[1]).toEqual({
        source: "sidecar",
        reason: "no readable .cm-info.json / .civitai.info sidecar next to the model",
      });
    }
  });
});
