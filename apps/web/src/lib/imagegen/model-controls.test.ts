import { describe, expect, test } from "bun:test";

import { buildSamplerControl, translateModelOptions } from "./model-controls.js";

describe("model-controls — buildSamplerControl (T1, the TWIN_UNIFICATION mechanism's first descriptor)", () => {
  test("gate closed (no sampler capability) → null, both surfaces render nothing", () => {
    expect(buildSamplerControl({ supportsSamplers: false, samplers: [{ name: "euler" }] })).toBeNull();
  });

  test("options: Auto carries its i18n KEY, live samplers carry raw names (the pinned T1 boundary)", () => {
    const spec = buildSamplerControl({ supportsSamplers: true, samplers: [{ name: "euler" }, { name: "ddim" }] });
    expect(spec!.options).toEqual([
      { kind: "key", id: "", labelKey: "image_gen_sampler_auto" },
      { kind: "raw", id: "euler", label: "euler" },
      { kind: "raw", id: "ddim", label: "ddim" },
    ]);
    expect(spec!.labelKey).toBe("image_gen_sampler_label");
  });

  test("commit: Auto ('') → undefined (inherit, the CF5 rule); a pick → the value", () => {
    const spec = buildSamplerControl({ supportsSamplers: true, samplers: [] });
    expect(spec!.commit("")).toEqual({ sampler: undefined });
    expect(spec!.commit("euler a")).toEqual({ sampler: "euler a" });
  });
});

describe("model-controls — translateModelOptions (the one translation flow, renderer-side)", () => {
  test("labelKey entries go through t; raw labels pass through untouched; ids preserved", () => {
    const spec = buildSamplerControl({ supportsSamplers: true, samplers: [{ name: "euler" }] })!;
    const seen: string[] = [];
    const rendered = translateModelOptions(spec.options, (key) => {
      seen.push(key);
      return `t:${key}`;
    });
    expect(rendered).toEqual([
      { id: "", label: "t:image_gen_sampler_auto" },
      { id: "euler", label: "euler" },
    ]);
    expect(seen).toEqual(["image_gen_sampler_auto"]);
  });
});
