/**
 * TtsAdapter.listTtsVoices — the kokoro guard (browser-only backend).
 *
 * Regression pin for the server-log crash the owner hit: a voices request for
 * a kokoro profile reached createTtsBackend("kokoro"), which has no registered
 * factory (kokoro synthesizes in the browser via Web Worker) — an unhandled
 * TtsBackendNotRegisteredError 500. The adapter must throw the typed
 * KokoroClientSideError instead (the route maps it to a clean 400), mirroring
 * the generate path.
 */
import { describe, expect, test } from "bun:test";

import { TtsAdapter, KokoroClientSideError } from "../src/api/adapters/tts-adapter.js";

function makeProfileRow(backend: string) {
  return {
    id: "tts1",
    name: "P",
    backend,
    config: {},
    voiceId: null,
    lang: null,
    sortOrder: 0,
    isDefault: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  } as never;
}

function makeAdapter(row: unknown) {
  return new TtsAdapter({
    tts: {
      getById: async () => row,
    } as never,
  });
}

describe("TtsAdapter.listTtsVoices — kokoro guard", () => {
  test("kokoro profile throws KokoroClientSideError (route maps to 400), not a registry crash", async () => {
    const adapter = makeAdapter(makeProfileRow("kokoro"));
    let caught: unknown = null;
    try {
      await adapter.listTtsVoices("tts1");
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof KokoroClientSideError).toBe(true);
  });

  test("missing profile resolves null (route 404s)", async () => {
    const adapter = makeAdapter(null);
    expect(await adapter.listTtsVoices("nope")).toBeNull();
  });
});
