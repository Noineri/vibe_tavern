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
  /** P14: the tree-listing fixture — answered for any
   *  `/api/models/<repo>/tree/main` URL; default = empty listing (no
   *  injectable sizes, mirrors the pre-P14 fail-soft shape). */
  let nextTreeResponse: () => Response | Promise<Response>;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "whisper-mirror-"));
    fetchLog = [];
    nextResponse = () => new Response("ok");
    nextTreeResponse = () => jsonResponse([]);
  });

  /** URL-dispatching fake (P14 shape): file requests go to nextResponse,
   *  tree-listing requests to nextTreeResponse — the size oracle rides the
   *  SAME injectable fetch seam, so tests dispatch by URL. */
  function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchLog.push({ url, init });
    const isTree = url.startsWith("https://huggingface.co/api/models/") && url.includes("/tree/main");
    const response = isTree ? nextTreeResponse() : nextResponse();
    return response instanceof Promise ? response : Promise.resolve(response);
  }

  function fileFetchLog(): { url: string }[] {
    return fetchLog.filter((e) => !(e.url.startsWith("https://huggingface.co/api/models/") && e.url.includes("/tree/main")));
  }

  function treeFetchLog(): { url: string }[] {
    return fetchLog.filter((e) => e.url.startsWith("https://huggingface.co/api/models/") && e.url.includes("/tree/main"));
  }

  function makeService(): WhisperMirrorService {
    return new WhisperMirrorService(dataDir, {
      resolveFetch: async () => fakeFetch,
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
    expect(fileFetchLog().length).toBe(1);
    expect(fileFetchLog()[0]?.url).toBe(buildWhisperHuggingFaceUrl(REPO, "config.json"));
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
    expect(fileFetchLog().length).toBe(1);
    // Cache hits carry the size from disk (Bun.file.size) — the bar stays
    // honest even when the cached file was length-less upstream.
    expect(result.contentLength).toBe(String("weights-bin".length));
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
    // One FILE fetch (single-flight) + at most one tree lookup (P14 oracle
    // is single-flight per repo too).
    expect(fileFetchLog().length).toBe(1);
    expect(treeFetchLog().length).toBeLessThanOrEqual(1);
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
    // File hops only — the CDN hop carries no Content-Length, so a tree
    // lookup (P14) also fires; its count is pinned separately.
    expect(fileFetchLog().map((e) => e.url)).toEqual([
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

  // ── P14: Content-Length injection for length-less upstream responses ──
  // The HF→CDN hop delivers without Content-Length; transformers.js then
  // stretches `total` per chunk and the download bar pins at 100%. The
  // mirror must resolve the true size from the tree listing and set it.
  test("length-less upstream gets Content-Length injected from the tree listing", async () => {
    nextResponse = () => new Response("weights-bin");
    nextTreeResponse = () =>
      jsonResponse([
        { type: "file", path: "onnx/model_quantized.onnx", size: 92361116, lfs: { size: 92361116 } },
        { type: "file", path: "config.json", size: 44 },
        { type: "directory", path: "onnx", size: 0 },
      ]);
    const service = makeService();
    const result = await service.handle(REPO, "onnx/model_quantized.onnx");
    if (result.status !== 200) throw new Error(`expected 200, got ${result.status}`);
    expect(result.contentLength).toBe("92361116");
    expect(treeFetchLog().length).toBe(1);
    expect(treeFetchLog()[0]?.url).toBe(
      "https://huggingface.co/api/models/onnx-community/whisper-base/tree/main?recursive=true",
    );
  });

  test("upstream-provided Content-Length wins — no tree lookup", async () => {
    nextResponse = () =>
      new Response("tiny", {
        headers: { "content-type": "text/plain", "content-length": "5" },
      });
    nextTreeResponse = () => {
      throw new Error("tree must not be called when upstream carries a length");
    };
    const service = makeService();
    const result = await service.handle(REPO, "config.json");
    if (result.status !== 200) throw new Error(`expected 200, got ${result.status}`);
    expect(result.contentLength).toBe("5");
    expect(treeFetchLog().length).toBe(0);
  });

  test("tree listing failure is fail-soft: file serves without a length", async () => {
    nextResponse = () => new Response("weights-bin");
    nextTreeResponse = () => Promise.reject(new Error("api down"));
    const service = makeService();
    const result = await service.handle(REPO, "onnx/model.onnx");
    if (result.status !== 200) throw new Error(`expected 200, got ${result.status}`);
    expect(result.contentLength).toBe("");
  });

  test("tree listing is cached per repo across files", async () => {
    nextResponse = () => new Response("data");
    nextTreeResponse = () =>
      jsonResponse([
        { type: "file", path: "config.json", size: 44 },
        { type: "file", path: "tokenizer.json", size: 2100000 },
      ]);
    const service = makeService();
    const first = await service.handle(REPO, "config.json");
    const second = await service.handle(REPO, "tokenizer.json");
    if (first.status !== 200 || second.status !== 200) throw new Error("expected 200s");
    expect(first.contentLength).toBe("44");
    expect(second.contentLength).toBe("2100000");
    // Two file fetches, ONE tree listing for the whole repo.
    expect(fileFetchLog().length).toBe(2);
    expect(treeFetchLog().length).toBe(1);
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
      resolveFetch: async () => (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        fetchLog.push({ url });
        // P14: tree-listing URLs (size oracle) get an empty listing; file
        // URLs get the fixture body WITHOUT a Content-Length — the CDN-hop
        // shape the oracle exists for.
        if (url.startsWith("https://huggingface.co/api/models/") && url.includes("/tree/main")) {
          return Promise.resolve(jsonResponse([]));
        }
        return Promise.resolve(new Response('{"ok":true}', { headers: { "content-type": "application/json" } }));
      },
    });
    return new Hono().route("/", createSttWhisperMirrorRoutes(service));
  }

  test("namespaced repo id + repo file reach upstream with the right repo and path", async () => {
    const app = makeApp();
    const res = await app.request("/api/stt/whisper/model/onnx-community/whisper-base/tokenizer.json");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    const fileFetches = fetchLog.filter((e) => !e.url.includes("/tree/main"));
    expect(fileFetches.length).toBe(1);
    expect(fileFetches[0]?.url).toBe("https://huggingface.co/onnx-community/whisper-base/resolve/main/tokenizer.json");
  });

  test("deep repo path (onnx/ subfolder weights) keeps the full repo id", async () => {
    const app = makeApp();
    const res = await app.request("/api/stt/whisper/model/onnx-community/whisper-base/onnx/encoder_model_quantized.onnx");
    expect(res.status).toBe(200);
    const fileFetches = fetchLog.filter((e) => !e.url.includes("/tree/main"));
    expect(fileFetches[0]?.url).toBe(
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
