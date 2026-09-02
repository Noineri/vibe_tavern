import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../../../test/dom-env.js";

useDomEnv();

import { __setSttDiscoveryDepsForTests } from "./use-stt-discovery.js";
import type { DiscoveredServer, ProbeOutcome } from "@vibe-tavern/domain";

const { render, act, cleanup } = await import("@testing-library/react");
const { useSttDiscovery } = await import("./use-stt-discovery.js");

function server(port: number, modelIds: string[] = []): DiscoveredServer {
  return { port, baseUrl: `http://127.0.0.1:${port}`, kind: "openai-compatible", voiceIds: [], modelIds };
}

function outcomeFound(port: number, modelIds: string[] = []): ProbeOutcome {
  return { port, status: "found", server: server(port, modelIds) };
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
    const api = useSttDiscovery();
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
  __setSttDiscoveryDepsForTests(null);
  cleanup();
});

describe("useSttDiscovery", () => {
  test("found servers recorded in order", async () => {
    const outcomes: ProbeOutcome[] = [outcomeFound(8000, ["whisper-1"]), outcomeRefused(7851), outcomeFound(8080)];
    const discoverMock = mock(async () => outcomes);
    __setSttDiscoveryDepsForTests({ discover: discoverMock });

    const { captured } = probeHarness();
    await act(async () => {
      await captured.current?.discover();
    });
    expect(captured.current?.servers.map((s) => s.port)).toEqual([8000, 8080]);
    expect(captured.current?.notFoundCodes).toBeNull();
    expect(captured.current?.scanning).toBe(false);
    expect(captured.current?.error).toBeNull();
  });

  test("zero-found fills notFoundCodes", async () => {
    const outcomes: ProbeOutcome[] = [outcomeRefused(8000), outcomeTimeout(7851), outcomeHttpOther(5000)];
    const discoverMock = mock(async () => outcomes);
    __setSttDiscoveryDepsForTests({ discover: discoverMock });

    const { captured } = probeHarness();
    await act(async () => {
      await captured.current?.discover();
    });
    expect(captured.current?.servers).toEqual([]);
    expect(captured.current?.notFoundCodes).not.toBeNull();
    expect(captured.current?.notFoundCodes).toEqual(["server-not-running", "timeout", "http-other"]);
  });

  test("second scan replaces results", async () => {
    const first: ProbeOutcome[] = [outcomeFound(8000)];
    const second: ProbeOutcome[] = [outcomeFound(8080)];
    let call = 0;
    const discoverMock = mock(async () => {
      call += 1;
      return call === 1 ? first : second;
    });
    __setSttDiscoveryDepsForTests({ discover: discoverMock });

    const { captured } = probeHarness();
    await act(async () => {
      await captured.current?.discover();
    });
    expect(captured.current?.servers.map((s) => s.port)).toEqual([8000]);
    await act(async () => {
      await captured.current?.discover();
    });
    expect(captured.current?.servers.map((s) => s.port)).toEqual([8080]);
  });

  test("promise rejection -> error state", async () => {
    const discoverMock = mock(async () => {
      throw new Error("network down");
    });
    __setSttDiscoveryDepsForTests({ discover: discoverMock });

    const { captured } = probeHarness();
    await act(async () => {
      await captured.current?.discover();
    });
    expect(captured.current?.error).toBe("network down");
    expect(captured.current?.servers).toEqual([]);
    expect(captured.current?.scanning).toBe(false);
  });
});
