import { describe, expect, test } from "bun:test";

import { buildKreaTwoControls, buildSamplerControl, translateModelOptions } from "./model-controls.js";

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

describe("model-controls — buildKreaTwoControls (T6: the pane section's home + the chip's accordion read ONE builder)", () => {
  test("gate: the krea backend's OWN krea/* models only; third-party models and other backends → null", () => {
    expect(buildKreaTwoControls({ backend: "krea", modelId: "krea/krea-2/medium" })).not.toBeNull();
    expect(buildKreaTwoControls({ backend: "krea", modelId: "google/nano-banana" })).toBeNull();
    expect(buildKreaTwoControls({ backend: "openrouter", modelId: "krea/krea-2/medium" })).toBeNull();
  });

  test("creativity: POLICY default raw, four literal option keys, commit patches the block keeping siblings", () => {
    const spec = buildKreaTwoControls({ backend: "krea", modelId: "krea/krea-2/medium" })!;
    expect(spec.creativity.default).toBe("raw");
    expect(spec.creativity.options.map((option) => option.labelKey)).toEqual([
      "image_gen_krea_creativity_raw",
      "image_gen_krea_creativity_low",
      "image_gen_krea_creativity_medium",
      "image_gen_krea_creativity_high",
    ]);
    expect(spec.creativity.commit({ intensity: 40 }, "high")).toEqual({ krea: { intensity: 40, creativity: "high" } });
  });

  test("sliders: intensity/complexity/movement at −100..100 step 1, neutral-0 defaults, commits keep siblings", () => {
    const spec = buildKreaTwoControls({ backend: "krea", modelId: "krea/krea-2/turbo" })!;
    expect(spec.sliders.map((slider) => [slider.field, slider.min, slider.max, slider.step, slider.default])).toEqual([
      ["intensity", -100, 100, 1, 0],
      ["complexity", -100, 100, 1, 0],
      ["movement", -100, 100, 1, 0],
    ]);
    const movement = spec.sliders[2]!;
    expect(movement.commit({ creativity: "low", intensity: -20 }, 55)).toEqual({
      krea: { creativity: "low", intensity: -20, movement: 55 },
    });
  });
});
