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
