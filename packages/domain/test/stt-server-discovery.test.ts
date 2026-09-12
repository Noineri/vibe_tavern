import { describe, expect, test } from "bun:test";

import { probeSttPort, discoverLocalSttServers, type FetchLike } from "../src/tts-server-discovery.js";

/** A stub ResponseLike pair returned by the fake FetchLike — `json` is
 *  called only when a probe reaches the parse step. */
function jsonResponse(status: number, body: unknown): {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
} {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Fake fetch keyed by URL tail: a per-path matcher map. Anything unmapped
 *  throws a network TypeError (refused). */
function fetchFor(routes: Record<string, ReturnType<typeof jsonResponse> | "timeout">): FetchLike {
  return async (input) => {
    const url = String(input);
    const match = routes[url] ?? routes[url.split("?")[0]!];
    if (match === undefined) throw new TypeError("refused");
    if (match === "timeout") {
      // Never settles — the prober's own AbortSignal timeout must fire.
      return await new Promise<never>(() => {});
    }
    return match;
  };
}

const MODEL_OK = jsonResponse(200, { data: [{ id: "whisper-1" }, { id: "gpt-4o" }] });
const MODEL_GARBAGE = jsonResponse(200, { nope: true });
const TRANSCRIPTIONS_405 = jsonResponse(405, {});
const TRANSCRIPTIONS_404 = jsonResponse(404, {});

describe("probeSttPort", () => {
  test("models ok + transcriptions 405 → found, openai-compatible, modelIds", async () => {
    const fetchLike = fetchFor({
      "http://127.0.0.1:8000/v1/models": MODEL_OK,
      "http://127.0.0.1:8000/v1/audio/transcriptions": TRANSCRIPTIONS_405,
    });
    const outcome = await probeSttPort(8000, fetchLike);
    expect(outcome.status).toBe("found");
    if (outcome.status !== "found") return;
    expect(outcome.server.kind).toBe("openai-compatible");
    expect(outcome.server.port).toBe(8000);
    expect(outcome.server.baseUrl).toBe("http://127.0.0.1:8000");
    expect(outcome.server.modelIds).toEqual(["whisper-1", "gpt-4o"]);
    expect(outcome.server.voiceIds).toEqual([]);
  });

  test("models ok but transcriptions 404 → NOT found (http-error 404)", async () => {
    const fetchLike = fetchFor({
      "http://127.0.0.1:8000/v1/models": MODEL_OK,
      "http://127.0.0.1:8000/v1/audio/transcriptions": TRANSCRIPTIONS_404,
    });
    const outcome = await probeSttPort(8000, fetchLike);
    expect(outcome.status).toBe("http-error");
    if (outcome.status === "http-error") expect(outcome.httpStatus).toBe(404);
  });

  test("both refused → refused", async () => {
    const fetchLike = fetchFor({});
    const outcome = await probeSttPort(8000, fetchLike);
    expect(outcome.status).toBe("refused");
  });

  test("models timeout → timeout", async () => {
    const fetchLike = fetchFor({
      "http://127.0.0.1:8000/v1/models": "timeout",
    });
    const outcome = await probeSttPort(8000, fetchLike, 50);
    expect(outcome.status).toBe("timeout");
  });

  test("models ok-but-garbage JSON → bad-shape (not found)", async () => {
    const fetchLike = fetchFor({
      "http://127.0.0.1:8000/v1/models": MODEL_GARBAGE,
      "http://127.0.0.1:8000/v1/audio/transcriptions": TRANSCRIPTIONS_405,
    });
    const outcome = await probeSttPort(8000, fetchLike);
    expect(outcome.status).toBe("bad-shape");
  });
});

describe("discoverLocalSttServers", () => {
  test("returns one outcome per probed port", async () => {
    // All refused — the prober still resolves one outcome per port.
    const fetchLike = fetchFor({});
    const outcomes = await discoverLocalSttServers(fetchLike);
    // The probe list is the shared TTS/STT port set (7 ports) — mirrored
    // from the TTS route test rather than importing the private const.
    expect(outcomes.length).toBe(7);
    expect(outcomes.every((o) => o.status === "refused")).toBe(true);
  });
});
