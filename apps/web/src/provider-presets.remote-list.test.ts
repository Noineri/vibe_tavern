import { describe, expect, test } from "bun:test";
import { PROVIDER_PRESET_GROUP, REMOTE_PROVIDER_PRESET_IDS } from "@vibe-tavern/domain";
import { PROVIDER_PRESETS } from "./provider-presets.js";

describe("REMOTE_PROVIDER_PRESET_IDS", () => {
  test("covers exactly the non-local presets of the actual registry", () => {
    const nonLocalIds: string[] = PROVIDER_PRESETS
      .filter((preset) => preset.group !== PROVIDER_PRESET_GROUP.local)
      .map((preset) => preset.id)
      .sort();
    const remoteIds: string[] = [...REMOTE_PROVIDER_PRESET_IDS].sort();

    expect(remoteIds).toEqual(nonLocalIds);
  });

  test("has no duplicates and no local preset leaked in", () => {
    expect(new Set(REMOTE_PROVIDER_PRESET_IDS).size).toBe(REMOTE_PROVIDER_PRESET_IDS.length);

    const localIds = new Set(
      PROVIDER_PRESETS
        .filter((preset) => preset.group === PROVIDER_PRESET_GROUP.local)
        .map((preset) => preset.id),
    );
    for (const id of REMOTE_PROVIDER_PRESET_IDS) {
      expect(localIds.has(id)).toBe(false);
    }
  });
});
