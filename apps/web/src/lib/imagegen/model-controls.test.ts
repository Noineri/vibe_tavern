import { describe, expect, test } from "bun:test";

import { buildSamplerControl } from "./model-controls.js";

const AUTO = "t:image_gen_sampler_auto";

describe("model-controls — buildSamplerControl (T1, the TWIN_UNIFICATION mechanism's first descriptor)", () => {
  test("gate closed (no sampler capability) → null, both surfaces render nothing", () => {
    expect(buildSamplerControl({ supportsSamplers: false, samplers: [{ name: "euler" }], autoLabel: AUTO })).toBeNull();
  });

  test("options: Auto first, then the live sampler list by name (the pinned T1 boundary)", () => {
    const spec = buildSamplerControl({ supportsSamplers: true, samplers: [{ name: "euler" }, { name: "ddim" }], autoLabel: AUTO });
    expect(spec!.options).toEqual([
      { id: "", label: AUTO },
      { id: "euler", label: "euler" },
      { id: "ddim", label: "ddim" },
    ]);
    expect(spec!.labelKey).toBe("image_gen_sampler_label");
  });

  test("commit: Auto ('') → undefined (inherit, the CF5 rule); a pick → the value", () => {
    const spec = buildSamplerControl({ supportsSamplers: true, samplers: [], autoLabel: AUTO });
    expect(spec!.commit("")).toEqual({ sampler: undefined });
    expect(spec!.commit("euler a")).toEqual({ sampler: "euler a" });
  });
});
