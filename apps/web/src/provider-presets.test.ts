import { describe, expect, test } from "bun:test";
import { COAUTHOR_TRANSPORT_CAPABILITIES, type ProviderPresetId } from "@vibe-tavern/domain";
import { PROVIDER_PRESETS } from "./provider-presets.js";

describe("provider preset transport classifications", () => {
  test("the actual preset registry and domain capability map are exhaustive peers", () => {
    const registryIds = PROVIDER_PRESETS.map((preset) => preset.id).sort();
    expect(new Set(registryIds).size).toBe(registryIds.length);
    // Keys are ProviderPresetId per the map's `satisfies` contract; Object.keys widens to string[].
    const capabilityIds = (Object.keys(COAUTHOR_TRANSPORT_CAPABILITIES) as ProviderPresetId[]).sort();
    expect(registryIds).toEqual(capabilityIds);
  });
});
