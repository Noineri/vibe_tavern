import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

import { __setTtsDiscoveryDepsForTests } from "./use-tts-discovery.js";
import type { DiscoveredServer, ProbeOutcome } from "@vibe-tavern/domain";

const { render, act, cleanup } = await import("@testing-library/react");
const { useTtsDiscovery } = await import("./use-tts-discovery.js");

function server(port: number, kind: DiscoveredServer["kind"] = "openai-compatible"): DiscoveredServer {
  return { port, baseUrl: `http://127.0.0.1:${port}`, kind, voiceIds: [`v${port}`], modelIds: [] };
}

function outcomeFound(port: number, kind: DiscoveredServer["kind"] = "openai-compatible"): ProbeOutcome {
  return { port, status: "found", server: server(port, kind) };
}

function outcomeRefused(port: number): ProbeOutcome {
  return { port, status: "refused" };
}

function outcomeTimeout(port: number): ProbeOutcome {
  return { port, status: "timeout" };
}

function outcomeHttpOther(port: number): ProbeOutcome {
  return { port, status: "http-error", httpStatus: 500 };
}

interface Captured {
  scanning: boolean;
  servers: DiscoveredServer[];
  notFoundCodes: import("@vibe-tavern/domain").DiscoveryDiagnosticCode[] | null;
  error: string | null;
  discover(): Promise<void>;
}

function probeHarness(): { captured: { current?: Captured } } {
  const captured: { current?: Captured } = {};
  function Probe() {
    const api = useTtsDiscovery();
    captured.current = api;
    return null;
  }
  render(React.createElement(Probe));
  return { captured };
}

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  __setTtsDiscoveryDepsForTests(null);
  cleanup();
});

describe("useTtsDiscovery", () => {
  test("found servers recorded in order", async () => {
    const outcomes: ProbeOutcome[] = [outcomeFound(8880, "kokoro-fastapi"), outcomeRefused(8000), outcomeFound(5050)];
    const discoverMock = mock(async () => outcomes);
    __setTtsDiscoveryDepsForTests({ discover: discoverMock });

    const { captured } = probeHarness();
    await act(async () => {
      await captured.current?.discover();
    });
    expect(captured.current?.servers.map((s) => s.port)).toEqual([8880, 5050]);
    expect(captured.current?.notFoundCodes).toBeNull();
    expect(captured.current?.scanning).toBe(false);
    expect(captured.current?.error).toBeNull();
  });

  test("zero-found fills notFoundCodes", async () => {
    const outcomes: ProbeOutcome[] = [outcomeRefused(8880), outcomeTimeout(8000), outcomeHttpOther(7851)];
    const discoverMock = mock(async () => outcomes);
    __setTtsDiscoveryDepsForTests({ discover: discoverMock });

    const { captured } = probeHarness();
    await act(async () => {
      await captured.current?.discover();
    });
    expect(captured.current?.servers).toEqual([]);
    expect(captured.current?.notFoundCodes).not.toBeNull();
    // The hook maps each outcome via diagnoseOutcome: refused->server-not-running, timeout, http-other
    expect(captured.current?.notFoundCodes).toEqual(["server-not-running", "timeout", "http-other"]);
  });

  test("second scan replaces results", async () => {
    const first: ProbeOutcome[] = [outcomeFound(8880)];
    const second: ProbeOutcome[] = [outcomeFound(5050)];
    let call = 0;
    const discoverMock = mock(async () => {
      call += 1;
      return call === 1 ? first : second;
    });
    __setTtsDiscoveryDepsForTests({ discover: discoverMock });

    const { captured } = probeHarness();
    await act(async () => {
      await captured.current?.discover();
    });
    expect(captured.current?.servers.map((s) => s.port)).toEqual([8880]);
    await act(async () => {
      await captured.current?.discover();
    });
    expect(captured.current?.servers.map((s) => s.port)).toEqual([5050]);
  });

  test("promise rejection -> error state", async () => {
    const discoverMock = mock(async () => {
      throw new Error("network down");
    });
    __setTtsDiscoveryDepsForTests({ discover: discoverMock });

    const { captured } = probeHarness();
    await act(async () => {
      await captured.current?.discover();
    });
    expect(captured.current?.error).toBe("network down");
    expect(captured.current?.servers).toEqual([]);
    expect(captured.current?.scanning).toBe(false);
  });
});
