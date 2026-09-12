/**
 * Whisper worker-URL resolution pins (STT_PLAN ST-3): same contract as the
 * Kokoro factory — the prod factory must point at the fixed asset
 * `assets/whisper-worker.js` emitted by the worker entrypoint build in
 * `scripts/build-web.ts`; the dev factory loads the raw .ts source. If the
 * prod branch ever regresses to the `new URL(...)` form, the prod app 404s
 * the worker and the model download stalls forever.
 */

import { describe, expect, test } from "bun:test";

import { whisperWorkerUrl } from "./whisper-worker-factory.js";

describe("whisperWorkerUrl", () => {
  test("dev: resolves the raw worker source next to this module", () => {
    const url = whisperWorkerUrl(false);
    expect(url).toContain("whisper-worker.ts");
  });

  test("prod: the fixed worker asset + app-version cache-bust", () => {
    const url = whisperWorkerUrl(true);
    expect(url.startsWith("/assets/whisper-worker.js?v=")).toBe(true);
    expect(url.length > "/assets/whisper-worker.js?v=".length).toBe(true); // some version present
  });

  test("prod URL never leaks the dev .ts form", () => {
    expect(whisperWorkerUrl(true)).not.toContain("whisper-worker.ts");
  });
});
