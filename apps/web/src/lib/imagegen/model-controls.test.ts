import { describe, expect, test } from "bun:test";

import { buildKreaTwoControls, buildSamplerControl, buildScalarSliders, buildSchedulerControl, buildSeedField, isLocalDialectBackend, translateModelOptions } from "./model-controls.js";

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

describe("model-controls — buildScalarSliders (T4: the ONE mirror-first range resolution)", () => {
  test("absent mirror → the global defaults (steps 1–150/1, cfg 1–30/0.5, clip-skip 1–12/1)", () => {
    const sliders = buildScalarSliders(undefined);
    expect(sliders.map((slider) => [slider.field, slider.range])).toEqual([
      ["steps", { min: 1, max: 150, step: 1 }],
      ["cfgScale", { min: 1, max: 30, step: 0.5 }],
      ["clipSkip", { min: 1, max: 12, step: 1 }],
    ]);
  });

  test("a declared mirror override wins for ITS field only; siblings fall back to globals", () => {
    const sliders = buildScalarSliders({ steps: { min: 2, max: 60, step: 2 } });
    expect(sliders[0]!.range).toEqual({ min: 2, max: 60, step: 2 });
    expect(sliders[1]!.range).toEqual({ min: 1, max: 30, step: 0.5 });
    expect(sliders[2]!.range).toEqual({ min: 1, max: 12, step: 1 });
  });

  test("commits are per-field scalars (the overlay/base patch shape both surfaces share)", () => {
    const [steps, cfg, clip] = buildScalarSliders(undefined);
    expect(steps.commit(30)).toEqual({ steps: 30 });
    expect(cfg.commit(4.5)).toEqual({ cfgScale: 4.5 });
    expect(clip.commit(2)).toEqual({ clipSkip: 2 });
  });
});

describe("model-controls — buildSeedField (T5: the ONE seed parse — garbage never wipes)", () => {
  test("empty (or whitespace) → inherit (undefined); a finite number (any sign) → the value", () => {
    const seed = buildSeedField();
    expect(seed.parse("")).toEqual({ seed: undefined });
    expect(seed.parse("   ")).toEqual({ seed: undefined });
    expect(seed.parse("42")).toEqual({ seed: 42 });
    expect(seed.parse(" -7 ")).toEqual({ seed: -7 });
  });

  test("non-finite garbage → null = NO COMMIT (the unified pane semantics)", () => {
    const seed = buildSeedField();
    expect(seed.parse("12abc")).toBeNull();
    expect(seed.parse("abc")).toBeNull();
  });
});

describe("model-controls — isLocalDialectBackend (T2: the ONE local-family predicate)", () => {
  test("a1111 + comfyui are the family; every other backend is not", () => {
    expect(isLocalDialectBackend("a1111")).toBe(true);
    expect(isLocalDialectBackend("comfyui")).toBe(true);
    expect(isLocalDialectBackend("krea")).toBe(false);
    expect(isLocalDialectBackend("openrouter")).toBe(false);
    expect(isLocalDialectBackend("bfl")).toBe(false);
  });
});

describe("model-controls — buildSchedulerControl (T2: gate + options + commit, ONE derivation)", () => {
  test("null off the local dialect family (cloud backends have no scheduler surface)", () => {
    expect(buildSchedulerControl({ backend: "openrouter" })).toBeNull();
    expect(buildSchedulerControl({ backend: "krea" })).toBeNull();
  });

  test("both local dialects get the spec — the auto (vendor-default) KEY entry heads the list", () => {
    for (const backend of ["a1111", "comfyui"] as const) {
      const spec = buildSchedulerControl({ backend });
      expect(spec).not.toBeNull();
      expect(spec!.labelKey).toBe("image_gen_scheduler_label");
      expect(spec!.options([])).toEqual([{ kind: "key", id: "", labelKey: "image_gen_sampler_auto" }]);
    }
  });

  test("server schedulers ride as RAW options with the label ?? name fallback", () => {
    const spec = buildSchedulerControl({ backend: "comfyui" })!;
    expect(spec.options([{ name: "karras", label: "Karras" }, { name: "sgm_uniform" }])).toEqual([
      { kind: "key", id: "", labelKey: "image_gen_sampler_auto" },
      { kind: "raw", id: "karras", label: "Karras" },
      { kind: "raw", id: "sgm_uniform", label: "sgm_uniform" },
    ]);
  });

  test("commit: the auto entry inherits (undefined); a scheduler name commits it", () => {
    const spec = buildSchedulerControl({ backend: "a1111" })!;
    expect(spec.commit("")).toEqual({ scheduler: undefined });
    expect(spec.commit("karras")).toEqual({ scheduler: "karras" });
  });
});
