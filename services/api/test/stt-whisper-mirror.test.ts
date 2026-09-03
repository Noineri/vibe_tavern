/**
 * Server-side Whisper mirror tests (STT_PLAN ST-3): repo allowlist boundary,
 * path validation, upstream tee→disk-cache, cache hits, upstream failure
 * mapping, single-flight. Mirrors the Kokoro mirror test design — the fetch
 * transport is injected, no network.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WhisperMirrorService,
  buildWhisperHuggingFaceUrl,
  isMirroredWhisperRepo,
  validateWhisperFilePath,
} from "../src/domain/stt/whisper-mirror.js";
import { Hono } from "hono";
import { createSttWhisperMirrorRoutes } from "../src/api/routes/stt-whisper-mirror.js";

const REPO = "onnx-community/whisper-base";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
}

describe("validateWhisperFilePath", () => {
  test("accepts plain repo file paths", () => {
    expect(validateWhisperFilePath("config.json")).toBe("config.json");
    expect(validateWhisperFilePath("onnx/model_quantized.onnx")).toBe("onnx/model_quantized.onnx");
  });

  test("rejects traversal, absolute, empty, and odd characters", () => {
    expect(validateWhisperFilePath("../escape.bin")).toBeNull();
    expect(validateWhisperFilePath("onnx/../../etc/passwd")).toBeNull();
    expect(validateWhisperFilePath("")).toBeNull();
    expect(validateWhisperFilePath("has space.onnx")).toBeNull();
    expect(validateWhisperFilePath("a%2fb.onnx")).toBeNull();
    expect(validateWhisperFilePath("back\\slash.onnx")).toBeNull();
  });
});

describe("repo allowlist", () => {
  test("roster repos are allowed, others are not", () => {
    expect(isMirroredWhisperRepo(REPO)).toBe(true);
    expect(isMirroredWhisperRepo("onnx-community/Kokoro-82M-v1.0-ONNX")).toBe(false);
    expect(isMirroredWhisperRepo("evil/whatever")).toBe(false);
  });

  test("upstream URL is the fixed HF resolve base", () => {
    expect(buildWhisperHuggingFaceUrl(REPO, "config.json")).toBe(
      "https://huggingface.co/onnx-community/whisper-base/resolve/main/config.json",
    );
  });
});

describe("WhisperMirrorService", () => {
  let dataDir: string;
  let fetchLog: { url: string; init?: RequestInit }[];
  let nextResponse: () => Response | Promise<Response>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "whisper-mirror-"));
    fetchLog = [];
    nextResponse = () => new Response("ok");
  });

  function makeService(): WhisperMirrorService {
    return new WhisperMirrorService(dataDir, {
      resolveFetch: async () => {
        return (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          fetchLog.push({ url, init });
          const response = nextResponse();
          return response instanceof Promise ? response : Promise.resolve(response);
        };
      },
    });
  }

  test("200 upstream: streams to the client AND lands in the disk cache", async () => {
    nextResponse = () => new Response('{"model_type":"whisper"}', {
      headers: { "content-type": "application/json" },
    });
    const service = makeService();
    const result = await service.handle(REPO, "config.json");
    if (result.status !== 200) throw new Error(`expected 200, got ${result.status}`);
    const text = await new Response(result.body).text();
    expect(text).toBe('{"model_type":"whisper"}');
    expect(fetchLog.length).toBe(1);
    expect(fetchLog[0]?.url).toBe(buildWhisperHuggingFaceUrl(REPO, "config.json"));
    // Cache write is async — poll briefly for the rename to land.
    for (let i = 0; i < 50; i += 1) {
      try {
        const cached = await readFile(join(dataDir, "whisper-model-cache", REPO, "config.json"), "utf8");
        expect(cached).toBe('{"model_type":"whisper"}');
        return;
      } catch {
        await Bun.sleep(20);
      }
    }
    throw new Error("cached file never appeared");
  });

  test("second request for the same path is served from disk (no upstream hit)", async () => {
    nextResponse = () => new Response("weights-bin");
    const service = makeService();
    await service.handle(REPO, "onnx/model_quantized.onnx");
    for (let i = 0; i < 50; i += 1) {
      try {
        await readFile(join(dataDir, "whisper-model-cache", REPO, "onnx/model_quantized.onnx"));
        break;
      } catch {
        await Bun.sleep(20);
      }
    }
    const result = await service.handle(REPO, "onnx/model_quantized.onnx");
    if (result.status !== 200) throw new Error(`expected 200, got ${result.status}`);
    expect(fetchLog.length).toBe(1);
  });

  test("non-allowlisted repo → 400 without any upstream request", async () => {
    const service = makeService();
    const result = await service.handle("evil/whatever", "config.json");
    expect(result.status).toBe(400);
    expect(fetchLog.length).toBe(0);
  });

  test("invalid path → 400", async () => {
    const service = makeService();
    const result = await service.handle(REPO, "../escape");
    expect(result.status).toBe(400);
  });

  test("upstream 404 → 404 passthrough, nothing cached", async () => {
    nextResponse = () => new Response("not found", { status: 404 });
    const service = makeService();
    const result = await service.handle(REPO, "missing.bin");
    expect(result.status).toBe(404);
  });

  test("upstream transport failure → 502", async () => {
    nextResponse = () => Promise.reject(new Error("proxy down"));
    const service = makeService();
    const result = await service.handle(REPO, "config.json");
    expect(result.status).toBe(502);
  });

  test("single-flight: concurrent identical paths share one upstream fetch", async () => {
    let releases = 0;
    nextResponse = () =>
      new Promise<Response>((resolve) => {
        releases += 1;
        resolve(new Response("shared"));
      });
    const service = makeService();
    const [a, b] = await Promise.all([
      service.handle(REPO, "tokenizer.json"),
      service.handle(REPO, "tokenizer.json"),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(fetchLog.length).toBe(1);
    expect(releases).toBe(1);
  });

  test("LFS redirect (302 → CDN) is followed manually, HTTPS-only", async () => {
    let calls = 0;
    nextResponse = () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn-lfs.hf.co/repos/abc" },
        });
      }
      return new Response("redirected-weights");
    };
    const service = makeService();
    const result = await service.handle(REPO, "onnx/model.onnx");
    if (result.status !== 200) throw new Error(`expected 200, got ${result.status}`);
    const text = await new Response(result.body).text();
    expect(text).toBe("redirected-weights");
    expect(fetchLog.map((e) => e.url)).toEqual([
      buildWhisperHuggingFaceUrl(REPO, "onnx/model.onnx"),
      "https://cdn-lfs.hf.co/repos/abc",
    ]);
  });

  test("redirect off HTTPS is rejected (502)", async () => {
    nextResponse = () =>
      new Response(null, { status: 302, headers: { location: "http://insecure.example/x" } });
    const service = makeService();
    const result = await service.handle(REPO, "onnx/model.onnx");
    expect(result.status).toBe(502);
  });
});

// ── Route-level parse (regression pin, owner bug report 2026-09-05) ────────
// The worker's URL rewriter maps
//   https://huggingface.co/onnx-community/whisper-base/resolve/main/<file>
// onto
//   /api/stt/whisper/model/onnx-community/whisper-base/<file>
// — repo ids are NAMESPACED ("owner/name"), so the route must match the
// roster repo as a PREFIX, not split at the first slash (the first slash
// sits INSIDE the repo id; splitting there produced
// repo="onnx-community" → 400 "Unknown model repository" for every real
// download — the model never loaded, first live click found it).
describe("stt-whisper-mirror route parse", () => {
  let dataDir: string;
  let fetchLog: { url: string }[];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "whisper-mirror-route-"));
    fetchLog = [];
  });

  function makeApp(): Hono {
    const service = new WhisperMirrorService(dataDir, {
      resolveFetch: async () => {
        return (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          fetchLog.push({ url });
          return Promise.resolve(new Response('{"ok":true}', { headers: { "content-type": "application/json" } }));
        };
      },
    });
    return new Hono().route("/", createSttWhisperMirrorRoutes(service));
  }

  test("namespaced repo id + repo file reach upstream with the right repo and path", async () => {
    const app = makeApp();
    const res = await app.request("/api/stt/whisper/model/onnx-community/whisper-base/tokenizer.json");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(fetchLog.length).toBe(1);
    expect(fetchLog[0]?.url).toBe("https://huggingface.co/onnx-community/whisper-base/resolve/main/tokenizer.json");
  });

  test("deep repo path (onnx/ subfolder weights) keeps the full repo id", async () => {
    const app = makeApp();
    const res = await app.request("/api/stt/whisper/model/onnx-community/whisper-base/onnx/encoder_model_quantized.onnx");
    expect(res.status).toBe(200);
    expect(fetchLog[0]?.url).toBe(
      "https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder_model_quantized.onnx",
    );
  });

  test("non-roster prefix is rejected with 400 and no upstream request", async () => {
    const app = makeApp();
    const res = await app.request("/api/stt/whisper/model/onnx-community/tokenizer.json");
    expect(res.status).toBe(400);
    expect(fetchLog.length).toBe(0);
  });
});
