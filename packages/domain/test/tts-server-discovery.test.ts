import { describe, expect, test } from "bun:test";
import {
  diagnoseOutcome,
  discoverLocalTtsServers,
  probeServerPort,
  type FetchLike,
  type ResponseLike,
} from "../src/tts-server-discovery.js";

function response(ok: boolean, status: number, body: unknown, shouldRejectJson = false): ResponseLike {
  return {
    ok,
    status,
    async json(): Promise<unknown> {
      if (shouldRejectJson) throw new SyntaxError("Unexpected token");
      return body;
    },
  };
}

function makeFetch(
  handler: (url: string) => Promise<ResponseLike> | ResponseLike,
): FetchLike {
  return (input: string) => {
    const result = handler(input);
    return Promise.resolve(result);
  };
}

describe("server-discovery", () => {
  test("found kokoro-fastapi: voices and models both ok", async () => {
    const fetchLike: FetchLike = makeFetch((url) => {
      if (url.endsWith("/v1/models")) {
        return response(true, 200, { data: [{ id: "kokoro" }, { id: "kokoro-r" }] });
      }
      if (url.endsWith("/v1/audio/voices")) {
        return response(true, 200, { voices: [{ id: "af_heart", name: "Heart" }, { id: "af_bella" }] });
      }
      return response(false, 404, {});
    });
    const outcome = await probeServerPort(8880, fetchLike);
    expect(outcome.status).toBe("found");
    expect(outcome.server?.kind).toBe("kokoro-fastapi");
    expect(outcome.server?.voiceIds).toEqual(["af_heart", "af_bella"]);
    expect(outcome.server?.port).toBe(8880);
    expect(outcome.server?.baseUrl).toBe("http://127.0.0.1:8880");
    const modelIds = outcome.server?.modelIds ?? [];
    expect(modelIds.includes("kokoro")).toBe(true);
    expect(modelIds.includes("kokoro-r")).toBe(true);
  });

  test("found openai-compatible: models ok, voices 404", async () => {
    const fetchLike: FetchLike = makeFetch((url) => {
      if (url.endsWith("/v1/models")) {
        return response(true, 200, { data: [{ id: "tts-1" }] });
      }
      if (url.endsWith("/v1/audio/voices")) {
        return response(false, 404, {});
      }
      return response(false, 404, {});
    });
    const outcome = await probeServerPort(8000, fetchLike);
    expect(outcome.status).toBe("found");
    expect(outcome.server?.kind).toBe("openai-compatible");
    expect(outcome.server?.voiceIds).toEqual([]);
    expect(outcome.server?.modelIds).toEqual(["tts-1"]);
  });

  test("refused: fetch throws TypeError", async () => {
    const fetchLike: FetchLike = () => {
      throw new TypeError("Failed to fetch");
    };
    const outcome = await probeServerPort(5000, fetchLike);
    expect(outcome.status).toBe("refused");
    expect(diagnoseOutcome(outcome)).toBe("server-not-running");
  });

  test("http-error: 401 maps to auth-or-http, 500 maps to http-other", async () => {
    const fetch401: FetchLike = makeFetch((url) => {
      if (url.endsWith("/v1/models")) return response(false, 401, {});
      return response(false, 404, {});
    });
    const outcome401 = await probeServerPort(5000, fetch401);
    expect(outcome401.status).toBe("http-error");
    expect(diagnoseOutcome(outcome401)).toBe("auth-or-http");

    const fetch500: FetchLike = makeFetch((url) => {
      if (url.endsWith("/v1/models")) return response(false, 500, {});
      return response(false, 404, {});
    });
    const outcome500 = await probeServerPort(5000, fetch500);
    expect(outcome500.status).toBe("http-error");
    expect(diagnoseOutcome(outcome500)).toBe("http-other");
  });

  test("bad-shape: unexpected JSON shape and invalid JSON body", async () => {
    const fetchBadShape: FetchLike = makeFetch((url) => {
      if (url.endsWith("/v1/models")) return response(true, 200, { unexpected: true });
      if (url.endsWith("/v1/audio/voices")) return response(false, 404, {});
      return response(false, 404, {});
    });
    const outcome1 = await probeServerPort(5000, fetchBadShape);
    expect(outcome1.status).toBe("bad-shape");
    expect(diagnoseOutcome(outcome1)).toBe("wrong-shape");

    const fetchInvalidJson: FetchLike = makeFetch((url) => {
      if (url.endsWith("/v1/models")) return response(true, 200, {}, true);
      if (url.endsWith("/v1/audio/voices")) return response(false, 404, {});
      return response(false, 404, {});
    });
    const outcome2 = await probeServerPort(5000, fetchInvalidJson);
    expect(outcome2.status).toBe("bad-shape");
  });

  test("timeout: never-resolving fetch", async () => {
    const fetchLike: FetchLike = () => new Promise<ResponseLike>(() => {});
    const outcome = await probeServerPort(5000, fetchLike, 10);
    expect(outcome.status).toBe("timeout");
    expect(diagnoseOutcome(outcome)).toBe("timeout");
  });

  test("discoverLocalTtsServers: mixed matrix, order preserved", async () => {
    const fetchLike: FetchLike = makeFetch((url) => {
      const portMatch = /:(\d+)\//.exec(url);
      const port = portMatch ? Number(portMatch[1]) : 0;
      const isModels = url.endsWith("/v1/models");
      const isVoices = url.endsWith("/v1/audio/voices");
      // 8880: found kokoro
      if (port === 8880) {
        if (isModels) return response(true, 200, { data: [{ id: "kokoro" }] });
        if (isVoices) return response(true, 200, { voices: [{ id: "af_heart" }] });
      }
      // 8000: found openai-compatible
      if (port === 8000) {
        if (isModels) return response(true, 200, { data: [{ id: "tts-1" }] });
        if (isVoices) return response(false, 404, {});
      }
      // 7851: refused
      if (port === 7851) throw new TypeError("refused");
      // 5000: http-error 500
      if (port === 5000) {
        if (isModels) return response(false, 500, {});
        if (isVoices) return response(false, 500, {});
      }
      // 5050: timeout (never resolves) — will be raced with timeoutMs 20
      if (port === 5050) return new Promise<ResponseLike>(() => {});
      return response(false, 404, {});
    });

    const outcomes = await discoverLocalTtsServers(fetchLike, 20);
    expect(outcomes).toHaveLength(5);
    // Order preserved: [8880, 8000, 7851, 5000, 5050]
    expect(outcomes[0]?.port).toBe(8880);
    expect(outcomes[0]?.status).toBe("found");
    expect(outcomes[0]?.server?.kind).toBe("kokoro-fastapi");

    expect(outcomes[1]?.port).toBe(8000);
    expect(outcomes[1]?.status).toBe("found");
    expect(outcomes[1]?.server?.kind).toBe("openai-compatible");

    expect(outcomes[2]?.port).toBe(7851);
    expect(outcomes[2]?.status).toBe("refused");

    expect(outcomes[3]?.port).toBe(5000);
    expect(outcomes[3]?.status).toBe("http-error");

    expect(outcomes[4]?.port).toBe(5050);
    expect(outcomes[4]?.status).toBe("timeout");
  });

  test("bare-array voices tolerance", async () => {
    const fetchLike: FetchLike = makeFetch((url) => {
      if (url.endsWith("/v1/models")) return response(false, 404, {});
      if (url.endsWith("/v1/audio/voices")) return response(true, 200, [{ id: "af_heart" }]);
      return response(false, 404, {});
    });
    const outcome = await probeServerPort(8880, fetchLike);
    expect(outcome.status).toBe("found");
    // Recognition is model-id-only now: a voices shape alone does NOT imply
    // kokoro (openai-edge-tts serves the same shapes and is not kokoro).
    expect(outcome.server?.kind).toBe("openai-compatible");
    expect(outcome.server?.voiceIds).toEqual(["af_heart"]);
  });

  test("openai-edge-tts wire shape: { models: [...] } key + voices — found, not kokoro", async () => {
    // Live-verified 2026-08-29: openai-edge-tts /v1/models returns
    // {"models":[{"id":"tts-1"},...]} (no `data` key) and /v1/audio/voices
    // returns {"voices":[{"id":"alloy","name":"en-US-JennyNeural"},...]}. 
    const fetchLike: FetchLike = makeFetch((url) => {
      if (url.endsWith("/v1/models")) {
        return response(true, 200, { models: [{ id: "tts-1" }, { id: "tts-1-hd" }, { id: "gpt-4o-mini-tts" }] });
      }
      if (url.endsWith("/v1/audio/voices")) {
        return response(true, 200, { voices: [{ id: "alloy", name: "en-US-JennyNeural" }, { id: "shimmer" }] });
      }
      return response(false, 404, {});
    });
    const outcome = await probeServerPort(5050, fetchLike);
    expect(outcome.status).toBe("found");
    expect(outcome.server?.kind).toBe("openai-compatible");
    expect(outcome.server?.modelIds).toEqual(["tts-1", "tts-1-hd", "gpt-4o-mini-tts"]);
    expect(outcome.server?.voiceIds).toEqual(["alloy", "shimmer"]);
  });

  test("kokoro recognition via model id when voices endpoint fails", async () => {
    const fetchLike: FetchLike = makeFetch((url) => {
      if (url.endsWith("/v1/models")) return response(true, 200, { data: [{ id: "my-kokoro-model" }] });
      if (url.endsWith("/v1/audio/voices")) return response(false, 404, {});
      return response(false, 404, {});
    });
    const outcome = await probeServerPort(8880, fetchLike);
    expect(outcome.status).toBe("found");
    expect(outcome.server?.kind).toBe("kokoro-fastapi");
    expect(outcome.server?.voiceIds).toEqual([]);
  });

  test("diagnoseOutcome maps all statuses", () => {
    expect(diagnoseOutcome({ port: 8880, status: "found" })).toBe("found");
    expect(diagnoseOutcome({ port: 8880, status: "refused" })).toBe("server-not-running");
    expect(diagnoseOutcome({ port: 8880, status: "bad-shape" })).toBe("wrong-shape");
    expect(diagnoseOutcome({ port: 8880, status: "timeout" })).toBe("timeout");
    expect(diagnoseOutcome({ port: 8880, status: "http-error", httpStatus: 401 })).toBe("auth-or-http");
    expect(diagnoseOutcome({ port: 8880, status: "http-error", httpStatus: 403 })).toBe("auth-or-http");
    expect(diagnoseOutcome({ port: 8880, status: "http-error", httpStatus: 500 })).toBe("http-other");
    expect(diagnoseOutcome({ port: 8880, status: "http-error" })).toBe("http-other");
  });
});
