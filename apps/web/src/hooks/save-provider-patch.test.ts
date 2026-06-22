import { describe, expect, test } from "bun:test";
import { buildFavoriteModelSwitchPatch } from "./save-provider-patch.js";

/**
 * Characterization test for the favorite-model-switch patch builder.
 *
 * This pins the contract for switching the active model from the chat-input
 * starred-models dropdown (`handleSelectFavoriteProviderModel`):
 *  - `defaultModel` is ALWAYS set to the new modelId.
 *  - `contextBudget` is overwritten from the favorite's cached `contextLength`
 *    ONLY when the profile has NOT pinned its budget AND the favorite has a
 *    positive contextLength.
 *
 * The pin rule mirrors the three ProviderModelSelector sites (which gate on
 * `&& !form.pinContextBudget`). Historically the chat-dropdown path did NOT
 * gate, so switching a starred model always reset the budget — the reported
 * "pinned context size resets on model switch" bug. These tests lock the fix.
 */
describe("buildFavoriteModelSwitchPatch", () => {
  test("unpinned + positive contextLength → overwrites contextBudget", () => {
    const patch = buildFavoriteModelSwitchPatch({
      modelId: "gpt-4o",
      favorite: { contextLength: 128000 },
      pinContextBudget: false,
    });
    expect(patch).toEqual({ defaultModel: "gpt-4o", contextBudget: 128000 });
  });

  test("pinned + positive contextLength → preserves budget (no overwrite)", () => {
    const patch = buildFavoriteModelSwitchPatch({
      modelId: "gpt-4o",
      favorite: { contextLength: 128000 },
      pinContextBudget: true,
    });
    expect(patch).toEqual({ defaultModel: "gpt-4o" });
    expect(patch.contextBudget).toBeUndefined();
  });

  test("unpinned + zero contextLength → no overwrite (guard > 0)", () => {
    const patch = buildFavoriteModelSwitchPatch({
      modelId: "claude-3",
      favorite: { contextLength: 0 },
      pinContextBudget: false,
    });
    expect(patch).toEqual({ defaultModel: "claude-3" });
  });

  test("unpinned + null contextLength → no overwrite", () => {
    const patch = buildFavoriteModelSwitchPatch({
      modelId: "claude-3",
      favorite: { contextLength: null },
      pinContextBudget: false,
    });
    expect(patch).toEqual({ defaultModel: "claude-3" });
  });

  test("no matching favorite → no overwrite even when unpinned", () => {
    const patch = buildFavoriteModelSwitchPatch({
      modelId: "unknown-model",
      favorite: undefined,
      pinContextBudget: false,
    });
    expect(patch).toEqual({ defaultModel: "unknown-model" });
  });

  test("defaultModel is always set regardless of pin/budget state", () => {
    for (const pinContextBudget of [false, true]) {
      const patch = buildFavoriteModelSwitchPatch({
        modelId: "llama-3",
        favorite: { contextLength: 8000 },
        pinContextBudget,
      });
      expect(patch.defaultModel).toBe("llama-3");
    }
  });
});
