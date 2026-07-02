import { describe, test, expect, mock } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";
import {
  filterToolCapableModels,
  useToolCapableModels,
  type ToolCapableModel,
} from "./useToolCapableModels.js";
import { useProviderDataStore } from "../../stores/provider-data-store.js";
import type { ProviderProfileRecord } from "../../api/types.js";

useDomEnv();

/**
 * Inline factory for a complete ClientProviderProfileRecord. The wire type has
 * ~40 required fields; this fills the sampler block with inert defaults so each
 * test overrides only what it exercises (id / cachedModels). Inline per the
 * repo's per-file factory convention — not shared, because the co-author model
 * tests are the only consumer of a cachedModels-bearing fixture right now.
 */
function makeProfile(overrides: Partial<ProviderProfileRecord> & { id: string }): ProviderProfileRecord {
  return {
    name: "Prof",
    providerPreset: "openai",
    endpoint: "https://x",
    defaultModel: null,
    visionModel: null,
    contextBudget: null,
    pinContextBudget: false,
    bindPerModel: false,
    maxTokens: 0,
    temperature: 1,
    topP: 1,
    topK: 0,
    minP: 0,
    topA: 0,
    typicalP: 1,
    tfsZ: 1,
    repeatLastN: 0,
    mirostat: 0,
    mirostatTau: 0,
    mirostatEta: 0,
    dryMultiplier: 0,
    dryBase: 0,
    dryAllowedLength: 0,
    drySequenceBreakers: [],
    xtcThreshold: 0,
    xtcProbability: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    repetitionPenalty: 1,
    stopSequences: [],
    logitBias: [],
    seed: null,
    reasoningEffort: "medium",
    showReasoning: false,
    streamResponse: false,
    customSamplers: false,
    isActive: true,
    createdAt: "",
    updatedAt: "",
    hasStoredApiKey: false,
    ...overrides,
  };
}

describe("filterToolCapableModels (pure predicate)", () => {
  test("keeps models that advertise tools via the live supportsTools flag", () => {
    const models = [
      { id: "gpt-4o", label: "gpt-4o", supportsTools: true },
      { id: "gpt-3.5", label: "gpt-3.5", supportsTools: false },
    ];
    const out = filterToolCapableModels(models);
    expect(out.map((m) => m.id)).toEqual(["gpt-4o"]);
  });

  test("keeps models that advertise tools via cached capabilities.tools", () => {
    const models = [
      { id: "claude-opus", label: "claude-opus", capabilities: { tools: true } },
      { id: "claude-haiku", label: "claude-haiku", capabilities: { tools: false } },
    ];
    const out = filterToolCapableModels(models);
    expect(out.map((m) => m.id)).toEqual(["claude-opus"]);
  });

  test("treats both shapes as equivalent (same fact, different layer)", () => {
    const models = [
      { id: "live-tool", label: "live-tool", supportsTools: true },
      { id: "cached-tool", label: "cached-tool", capabilities: { tools: true } },
      { id: "live-no", label: "live-no", supportsTools: false },
      { id: "cached-no", label: "cached-no", capabilities: { tools: false } },
    ];
    const out = filterToolCapableModels(models);
    expect(out.map((m) => m.id).sort()).toEqual(["cached-tool", "live-tool"]);
  });

  test("drops models that carry neither field", () => {
    const models = [
      { id: "bare", label: "bare" },
      { id: "named", label: "named", supportsTools: true },
    ];
    const out = filterToolCapableModels(models);
    expect(out.map((m) => m.id)).toEqual(["named"]);
  });

  test("preserves the full input shape (does not strip fields)", () => {
    const models = [
      {
        id: "rich",
        label: "rich",
        contextLength: 128000,
        supportsTools: true,
        pricing: { input: 1, output: 2 },
      },
    ];
    const out = filterToolCapableModels(models);
    expect(out).toHaveLength(1);
    expect(out[0].contextLength).toBe(128000);
    expect(out[0]).toHaveProperty("pricing");
  });

  test("returns an empty array when no model is tool-capable", () => {
    const models = [
      { id: "a", label: "a", supportsTools: false },
      { id: "b", label: "b", capabilities: { tools: false } },
    ];
    expect(filterToolCapableModels(models)).toEqual([]);
  });
});

describe("useToolCapableModels (hook)", () => {
  test("returns an empty list and does not fetch when profileId is null", async () => {
    const { result } = renderHook(() => useToolCapableModels(null));
    expect(result.current.models).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("serves cached models from the profile without a network fetch", async () => {
    // Seed the store with a profile whose cachedModels advertise two tool-capable
    // models and one non-tool model. The hook must serve only the capable ones
    // without invoking the live fetch.
    useProviderDataStore.setState({
      profiles: [
        makeProfile({
          id: "prof-1",
          cachedModels: {
            models: [
              { id: "tool-a", label: "A", capabilities: { tools: true } },
              { id: "tool-b", label: "B", capabilities: { tools: true } },
              { id: "no-tools", label: "C", capabilities: { tools: false } },
            ],
            cachedAt: "",
          },
        }),
      ],
      favoritesByProfile: {},
    });

    const { result } = renderHook(() => useToolCapableModels("prof-1"));

    // Cached path resolves within the effect — settled on first tick.
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    const ids = result.current.models.map((m: ToolCapableModel) => m.id);
    expect(ids.sort()).toEqual(["tool-a", "tool-b"]);
    expect(result.current.error).toBeNull();
  });

  test("falls back to a live fetch and filters when the cache is empty", async () => {
    // Empty cache → the hook must call fetchProviderProfileModels and filter.
    // Mock the module AFTER capturing the real export so only the function under
    // test is replaced and every other export stays genuine (AGENTS.md
    // mock.module gotcha — a mock factory persists process-globally otherwise).
    const real = await import("../../api/provider-api.js");
    const fetchSpy = mock(() =>
      Promise.resolve({
        models: [
          { id: "live-tool", label: "Live Tool", supportsTools: true },
          { id: "live-no", label: "Live No", supportsTools: false },
        ],
      }),
    );
    mock.module("../../api/provider-api.js", () => ({ ...real, fetchProviderProfileModels: fetchSpy }));

    useProviderDataStore.setState({
      profiles: [makeProfile({ id: "prof-2", cachedModels: { models: [], cachedAt: "" } })],
      favoritesByProfile: {},
    });

    const { result } = renderHook(() => useToolCapableModels("prof-2"));

    await waitFor(() => {
      expect(result.current.models.map((m: ToolCapableModel) => m.id)).toEqual(["live-tool"]);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();

    mock.restore();
  });
});
