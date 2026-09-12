/**
 * restoreMirrorContentLength (P14 wire fix) — the worker-side half of the
 * mirror Content-Length contract:
 * - length-less response + mirror header → reconstructed twin with a real
 *   `content-length` (body and status pass through);
 * - response already carrying `content-length` → SAME object, untouched;
 * - response with neither header → SAME object, untouched.
 */

import { describe, expect, test } from "bun:test";

import { MIRROR_CONTENT_LENGTH_HEADER } from "@vibe-tavern/domain";

import { restoreMirrorContentLength } from "./mirror-content-length.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

describe("restoreMirrorContentLength", () => {
  test("length-less mirror response gets a real content-length header", () => {
    const body = streamOf(["abc", "def"]);
    const response = new Response(body, {
      status: 200,
      headers: { [MIRROR_CONTENT_LENGTH_HEADER]: "6" },
    });
    const restored = restoreMirrorContentLength(response);
    expect(restored).not.toBe(response);
    expect(restored.headers.get("content-length")).toBe("6");
    // The mirror header survives too (harmless; keeps the audit trail).
    expect(restored.headers.get(MIRROR_CONTENT_LENGTH_HEADER)).toBe("6");
  });

  test("body and status pass through the reconstruction", async () => {
    const response = new Response(streamOf(["xy"]), {
      status: 200,
      headers: { [MIRROR_CONTENT_LENGTH_HEADER]: "2" },
    });
    const restored = restoreMirrorContentLength(response);
    expect(restored.status).toBe(200);
    expect(new TextDecoder().decode(await restored.arrayBuffer())).toBe("xy");
  });

  test("response that already has content-length is returned as the SAME object", () => {
    const response = new Response(streamOf([]), {
      headers: { "content-length": "10", [MIRROR_CONTENT_LENGTH_HEADER]: "10" },
    });
    expect(restoreMirrorContentLength(response)).toBe(response);
  });

  test("response with neither header is returned as the SAME object", () => {
    const response = new Response(streamOf([]));
    expect(restoreMirrorContentLength(response)).toBe(response);
  });
});
