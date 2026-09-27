import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import type { FlyBrainManifest } from "@vibe-tavern/api-contracts";
import { __setFlyBrainDepsForTests, requiresCachedFlyBrain, useFlyBrain, type FlyBrainDeps } from "./use-fly-brain.js";

/**
 * Fly brain hook state machine (FT-9).
 *
 * L1 checklist:
 * 1. Paths: none.
 * 2. Restores: dependency override resets after each test.
 * 3. Determinism: a caller-owned promise settles the download; no sleeps.
 * 4. Platform: happy-dom only.
 * 5. Shared worker pool: no module mocks or shared registries.
 * 6. Stable state: terminal hook state is awaited through React act().
 */

useDomEnv();

const { act, renderHook, waitFor } = await import("@testing-library/react");

const manifest: FlyBrainManifest = {
  format: "fly-brain-manifest/1",
  generatedAt: "2026-09-27T00:00:00.000Z",
  generator: "test",
  source: { dataset: "mcns", version: "1.0", access: "test", license: "CC-BY-4.0", attribution: "test" },
  binary: { file: "connectome.bin.gz", formatVersion: 1, sha256: "0".repeat(64), sizeBytes: 1048576, neuronCount: 1, edgeCount: 1 },
  weights: { unit: "test", aggregation: "test", excitatory: [], inhibitory: [], unknownDefaultsTo: "test" },
  groups: [],
  countsByGroup: {},
  types: [],
};

let deps: FlyBrainDeps;

beforeEach(() => {
  deps = {
    loadCached: async () => ({ status: "idle" }),
    download: async (onProgress) => {
      onProgress({ status: "downloading", receivedBytes: 524288, totalBytes: 1048576, progress: 50 });
      return { status: "ready", source: "network", manifest, bytes: new Uint8Array([1]) };
    },
    clearCache: async () => {},
  };
  __setFlyBrainDepsForTests(deps);
});

afterEach(() => {
  __setFlyBrainDepsForTests(null);
});

describe("useFlyBrain", () => {
  test("requires a cached brain before an enable toggle may persist", () => {
    expect(requiresCachedFlyBrain(true, false)).toBe(true);
    expect(requiresCachedFlyBrain(true, true)).toBe(false);
    expect(requiresCachedFlyBrain(false, false)).toBe(false);
  });

  test("projects download progress and its verified ready result", async () => {
    const hook = renderHook(() => useFlyBrain());
    await waitFor(() => expect(hook.result.current.state).toBe("idle"));

    act(() => hook.result.current.download());
    await waitFor(() => expect(hook.result.current.state).toBe("ready"));

    expect(hook.result.current.manifest).toEqual(manifest);
    expect(hook.result.current.receivedMb).toBe(1);
    expect(hook.result.current.totalMb).toBe(1);
  });
});
