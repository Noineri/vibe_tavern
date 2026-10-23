/**
 * PD-3 pin — the payload `handleCreateProviderProfile` (settings "new profile")
 * sends equals the domain generation defaults for every generation field it
 * carries, plus the web's named new-profile context budget (16000). The seam is
 * the provider API (`saveProviderProfile`); the real store actions run.
 * The `...real` spread keeps every other export genuine for later files
 * sharing the worker.
 */
import { describe, expect, it, mock } from "bun:test";

import { PROVIDER_PROFILE_GENERATION_DEFAULTS } from "@vibe-tavern/domain";
import { useDomEnv } from "../../test/dom-env.js";

useDomEnv();

const { renderHook, act } = await import("@testing-library/react");

import type { ProviderProfileRecord } from "../api/types.js";

const realProviderApi = await import("../api/provider-api.js");

const saveProviderProfile = mock(async (input: Record<string, unknown>): Promise<ProviderProfileRecord> => (
  { id: "created", ...input } as unknown as ProviderProfileRecord
));
const listProviderProfiles = mock(async (): Promise<ProviderProfileRecord[]> => []);

mock.module("../api/provider-api.js", () => ({
  ...realProviderApi,
  saveProviderProfile,
  listProviderProfiles,
}));

const { useProviderProfiles } = await import("./use-provider-profiles.js");

describe("handleCreateProviderProfile payload (PD-3)", () => {
  it("carries the domain generation defaults for every generation field and contextBudget 16000", async () => {
    saveProviderProfile.mockClear();
    const { result } = renderHook(() => useProviderProfiles());

    await act(async () => {
      await result.current.handleCreateProviderProfile();
    });

    expect(saveProviderProfile).toHaveBeenCalledTimes(1);
    const payload = saveProviderProfile.mock.calls[0]![0];
    const D = PROVIDER_PROFILE_GENERATION_DEFAULTS;

    expect(payload).toMatchObject({
      temperature: D.temperature,
      topP: D.topP,
      minP: D.minP,
      topK: D.topK,
      topA: D.topA,
      frequencyPenalty: D.frequencyPenalty,
      presencePenalty: D.presencePenalty,
      repetitionPenalty: D.repetitionPenalty,
      maxTokens: D.maxTokens,
      stopSequences: D.stopSequences,
      seed: D.seed,
      reasoningEffort: D.reasoningEffort,
      showReasoning: D.showReasoning,
      streamResponse: D.streamResponse,
      customSamplers: D.customSamplers,
    });
    expect(payload.contextBudget).toBe(16000);
    // Non-generation fields keep their own values.
    expect(payload.endpoint).toBe("");
    expect(payload.proxyMode).toBe("inherit");
    expect(payload.proxyId).toBeNull();
  });
});
