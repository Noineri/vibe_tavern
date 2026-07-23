import { describe, expect, test } from "vitest";
import { COAUTHOR_TRANSPORT_CAPABILITIES } from "@vibe-tavern/domain";
import { PROVIDER_PRESETS } from "./provider-presets.js";

describe("provider preset transport classifications", () => {
  test("the actual preset registry and domain capability map are exhaustive peers", () => {
    const registryIds = PROVIDER_PRESETS.map((preset) => preset.id).sort();
    expect(new Set(registryIds).size).toBe(registryIds.length);
    expect(registryIds).toEqual(Object.keys(COAUTHOR_TRANSPORT_CAPABILITIES).sort());
  });
});
