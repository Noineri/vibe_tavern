/**
 * Model-mirror WIRE tests (P14 part 2) — the transport pins `app.request()`
 * could never check (owner bug report 2026-09-06: the loader bar jumps
 * straight to the cap). Hono's `app.request()` hands back the Response
 * OBJECT in-process and never crosses Bun.serve, so transport behavior
 * (which headers survive to the wire) is invisible to it. These tests serve
 * the REAL route modules through a real Bun.serve socket on an ephemeral
 * port and fetch over HTTP:
 *
 * - MISS (upstream stream): Bun.serve strips an explicit Content-Length
 *   from streaming bodies and answers chunked — the mirror's true size must
 *   survive in the custom `x-mirror-content-length` header, which the
 *   worker-side fetch wrapper turns back into a real content-length.
 * - HIT (disk cache): the route answers with a Bun.file body — Bun.serve
 *   sends a REAL Content-Length on the wire (sendfile), no reconstruction
 *   needed.
 *
 * Both mirrors (whisper STT, kokoro TTS) are pinned: the mechanism lives in
 * domain/model-mirror.ts + the two route modules, and each route must emit
 * the header on its own.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MIRROR_CONTENT_LENGTH_HEADER } from "@vibe-tavern/domain";

import { createKokoroMirrorRoutes } from "../src/api/routes/kokoro-mirror.js";
import { createSttWhisperMirrorRoutes } from "../src/api/routes/stt-whisper-mirror.js";
import { WhisperMirrorService } from "../src/domain/stt/whisper-mirror.js";
import { KokoroMirrorService } from "../src/domain/tts/kokoro-mirror.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

/** URL-dispatching fake upstream (same shape as the service-level tests):
 *  HF tree-listing requests (the P14 size oracle) get a per-repo listing
 *  carrying the size of THE test file (the listing URL carries no file
 *  path — `tree/main?recursive=true` — files are entries in the array);
 *  file requests get a LENGTH-LESS streaming 200 (the CDN hop after the
 *  LFS redirect). */
function makeFakeUpstream(filePath: string, fileBytes: string) {
  const fileSize = fileBytes.length;
  return (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const isTree = url.startsWith("https://huggingface.co/api/models/") && url.includes("/tree/main");
    if (isTree) {
      return Promise.resolve(
        jsonResponse([{ path: filePath, type: "file", size: fileSize, lfs: { size: fileSize } }]),
      );
    }
    // No content-length header — the wire defect's upstream trigger.
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(fileBytes));
        controller.close();
      },
    })));
  };
}

/** Wait until the disk cache file exists (the tee'd cache write can lag the
 *  client-side stream completion by a tick). */
async function waitForCacheFile(path: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await Bun.file(path).exists()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("cache file never appeared: " + path);
}

describe("model mirrors on the wire (real socket)", () => {
  let dataDir: string;
  let whisperServer: { port: number; stop: (force: boolean) => Promise<void> };
  let kokoroServer: { port: number; stop: (force: boolean) => Promise<void> };
  const bytes = "wire-level-payload";
  const size = String(bytes.length);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "mirror-wire-"));
    const whisperService = new WhisperMirrorService(dataDir, {
      resolveFetch: async () => makeFakeUpstream("config.json", bytes),
    });
    const kokoroService = new KokoroMirrorService(dataDir, {
      resolveFetch: async () => makeFakeUpstream("config.json", bytes),
    });
    whisperServer = Bun.serve({ port: 0, fetch: createSttWhisperMirrorRoutes(whisperService).fetch });
    kokoroServer = Bun.serve({ port: 0, fetch: createKokoroMirrorRoutes(kokoroService).fetch });
  });

  afterAll(async () => {
    await whisperServer.stop(true);
    await kokoroServer.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  });

  test("whisper MISS: true size survives Bun.serve's chunked re-encode in the mirror header", async () => {
    const response = await fetch(
      `http://127.0.0.1:${whisperServer.port}/api/stt/whisper/model/onnx-community/whisper-base/config.json`,
    );
    expect(response.status).toBe(200);
    // THE wire pin: chunked transport strips Content-Length, so the size
    // must ride the custom header (the worker rebuilds content-length from
    // it before transformers.js reads the Response).
    expect(response.headers.get(MIRROR_CONTENT_LENGTH_HEADER)).toBe(size);
    expect(await response.text()).toBe(bytes);
    await waitForCacheFile(join(dataDir, "whisper-model-cache", "onnx-community/whisper-base/config.json"));
  });

  test("whisper HIT: cache answers with a REAL Content-Length on the wire", async () => {
    const response = await fetch(
      `http://127.0.0.1:${whisperServer.port}/api/stt/whisper/model/onnx-community/whisper-base/config.json`,
    );
    expect(response.status).toBe(200);
    // Bun.file body → sendfile → genuine Content-Length. This is exactly
    // what `app.request()` could not observe (owner-verified: the first
    // P14 fix "worked" in object-level tests and still broke in the
    // browser).
    expect(response.headers.get("content-length")).toBe(size);
    expect(response.headers.get(MIRROR_CONTENT_LENGTH_HEADER)).toBe(size);
    expect(await response.text()).toBe(bytes);
  });

  test("kokoro MISS + HIT: the twin route emits the same wire contract", async () => {
    const miss = await fetch(`http://127.0.0.1:${kokoroServer.port}/api/tts/kokoro/model/config.json`);
    expect(miss.status).toBe(200);
    expect(miss.headers.get(MIRROR_CONTENT_LENGTH_HEADER)).toBe(size);
    expect(await miss.text()).toBe(bytes);
    await waitForCacheFile(join(dataDir, "kokoro-model-cache", "config.json"));

    const hit = await fetch(`http://127.0.0.1:${kokoroServer.port}/api/tts/kokoro/model/config.json`);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("content-length")).toBe(size);
    expect(await hit.text()).toBe(bytes);
  });
});
