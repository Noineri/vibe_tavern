import { describe, expect, test } from "bun:test";

import { HIRES_DISPLAY_ANCHORS, buildAdetailerControl, buildDitSidecarControls, buildHiresControl, buildKreaTwoControls, buildSamplerControl, buildScalarSliders, buildSchedulerControl, buildSeedField, isLocalDialectBackend, translateModelOptions } from "./model-controls.js";

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

describe("model-controls — buildHiresControl (T8: the chip and pane read ONE descriptor)", () => {
  test("closed gate returns null, following the shared don't-render convention", () => {
    expect(buildHiresControl({ supportsHiresFix: false })).toBeNull();
  });

  test("sliders pin field order, literal keys, domain ranges, and the A1111 display anchors", () => {
    const spec = buildHiresControl({ supportsHiresFix: true })!;
    expect(HIRES_DISPLAY_ANCHORS).toEqual({ steps: 0, scale: 2, denoisingStrength: 0.75 });
    expect(spec.labelKey).toBe("image_gen_hires_label");
    expect(spec.upscalerLabelKey).toBe("image_gen_hires_upscaler_label");
    expect(spec.upscalerAutoLabelKey).toBe("image_gen_hires_upscaler_auto");
    expect(spec.sliders).toEqual([
      {
        field: "steps",
        labelKey: "image_gen_hires_steps_label",
        range: { min: 0, max: 150, step: 1 },
        displayAnchor: 0,
      },
      {
        field: "scale",
        labelKey: "image_gen_hires_scale_label",
        range: { min: 1, max: 4, step: 0.05 },
        displayAnchor: 2,
      },
      {
        field: "denoisingStrength",
        labelKey: "image_gen_hires_denoise_label",
        range: { min: 0, max: 1, step: 0.05 },
        displayAnchor: 0.75,
      },
    ]);
  });

  test("upscaler options keep Auto first, carry live names, and retain a stale stored pick exactly once", () => {
    const spec = buildHiresControl({ supportsHiresFix: true })!;
    expect(spec.upscalerOptions(null, undefined)).toEqual([
      { kind: "key", id: "", labelKey: "image_gen_hires_upscaler_auto" },
    ]);
    expect(spec.upscalerOptions([{ name: "Latent" }, { name: "4x-UltraSharp" }], undefined)).toEqual([
      { kind: "key", id: "", labelKey: "image_gen_hires_upscaler_auto" },
      { kind: "raw", id: "Latent", label: "Latent" },
      { kind: "raw", id: "4x-UltraSharp", label: "4x-UltraSharp" },
    ]);
    expect(spec.upscalerOptions([{ name: "Latent" }], "Removed-Upscaler")).toEqual([
      { kind: "key", id: "", labelKey: "image_gen_hires_upscaler_auto" },
      { kind: "raw", id: "Latent", label: "Latent" },
      { kind: "raw", id: "Removed-Upscaler", label: "Removed-Upscaler" },
    ]);
    expect(spec.upscalerOptions([{ name: "Latent" }], "Latent")).toHaveLength(2);
  });

  test("commit maps Auto to inherit and preserves a picked upscaler id", () => {
    const spec = buildHiresControl({ supportsHiresFix: true })!;
    expect(spec.commitUpscaler("")).toBeUndefined();
    expect(spec.commitUpscaler("4x-UltraSharp")).toBe("4x-UltraSharp");
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

describe("model-controls — scalar capability gates (T4/T5)", () => {
  test("a krea-style capability mirror renders no scalar sliders but keeps seed", () => {
    const sliders = buildScalarSliders({});
    expect(sliders).toEqual([undefined, undefined, undefined, undefined]);
    expect(buildSeedField({ supportsSeed: true })).not.toBeNull();
  });

  test("a seed-less mirror renders neither scalar sliders nor seed", () => {
    const sliders = buildScalarSliders({});
    expect(sliders).toEqual([undefined, undefined, undefined, undefined]);
    expect(buildSeedField({ supportsSeed: false })).toBeNull();
  });

  test("a1111 keeps stable slots for steps and cfg only; its deliberately unwired clip skip stays absent", () => {
    const [steps, cfg, clip] = buildScalarSliders({
      supportsSteps: true,
      supportsCfgScale: true,
      paramRanges: { steps: { min: 2, max: 60, step: 2 } },
    });
    expect(steps!.range).toEqual({ min: 2, max: 60, step: 2 });
    expect(cfg!.range).toEqual({ min: 1, max: 30, step: 0.5 });
    expect(clip).toBeUndefined();
    expect(steps!.commit(30)).toEqual({ steps: 30 });
    expect(cfg!.commit(4.5)).toEqual({ cfgScale: 4.5 });
  });

  test("CFG-1 workflow families hide both CFG controls while mixed families retain them", () => {
    for (const workflowFamily of ["qwen-image-2.1", "flux-schnell"]) {
      const sliders = buildScalarSliders({ capabilities: { supportsCfgScale: true }, backend: "comfyui", workflowFamily });
      expect(sliders[1]).toBeUndefined();
      expect(sliders[3]).toBeUndefined();
    }
    for (const workflowFamily of ["flux-dev", "krea2-dit", "qwen-image", "z-image"]) {
      const sliders = buildScalarSliders({ capabilities: { supportsCfgScale: true }, backend: "comfyui", workflowFamily });
      expect(sliders[1]?.field).toBe("cfgScale");
      expect(sliders[3]?.field).toBe("cfgRescale");
    }
    expect(buildScalarSliders({ capabilities: { supportsCfgScale: true }, backend: "openrouter" })[3]).toBeUndefined();
  });

  test("comfyui is the only all-four fixture: every scalar slot and seed are present", () => {
    const [steps, cfg, clip] = buildScalarSliders({
      supportsSteps: true,
      supportsCfgScale: true,
      supportsClipSkip: true,
    });
    expect(steps!.range).toEqual({ min: 1, max: 150, step: 1 });
    expect(cfg!.range).toEqual({ min: 1, max: 30, step: 0.5 });
    expect(clip!.range).toEqual({ min: 1, max: 12, step: 1 });
    expect(clip!.commit(2)).toEqual({ clipSkip: 2 });
    expect(buildSeedField({ supportsSeed: true })).not.toBeNull();
  });
});

describe("model-controls — buildSeedField (T5: the ONE seed parse — garbage never wipes)", () => {
  test("empty (or whitespace) → inherit (undefined); a finite number (any sign) → the value", () => {
    const seed = buildSeedField({ supportsSeed: true })!;
    expect(seed.parse("")).toEqual({ seed: undefined });
    expect(seed.parse("   ")).toEqual({ seed: undefined });
    expect(seed.parse("42")).toEqual({ seed: 42 });
    expect(seed.parse(" -7 ")).toEqual({ seed: -7 });
  });

  test("non-finite garbage → null = NO COMMIT (the unified pane semantics)", () => {
    const seed = buildSeedField({ supportsSeed: true })!;
    expect(seed.parse("12abc")).toBeNull();
    expect(seed.parse("abc")).toBeNull();
  });

  test("randomSeed mirrors ComfyUI's concrete integer range", () => {
    const value = buildSeedField({ supportsSeed: true })!.randomSeed();
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(Number.MAX_SAFE_INTEGER);
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

describe("model-controls — buildAdetailerControl (T7: the ONE dialect tri-state)", () => {
  test("a1111: a matching answered extension probe is ready with static options, a dynamic base-steps placeholder, and fallback; any absence stays hidden", () => {
    const ready = buildAdetailerControl({
      backend: "a1111",
      extensions: ["sd-webui-adetailer"],
      faceDetectors: null,
      baseSteps: 37,
    });
    expect(ready).toEqual({
      state: "ready",
      options: [
        { kind: "raw", id: "face_yolov8n.pt", label: "face_yolov8n.pt" },
        { kind: "raw", id: "face_yolov8s.pt", label: "face_yolov8s.pt" },
        { kind: "raw", id: "mediapipe_face_full", label: "mediapipe_face_full" },
        { kind: "raw", id: "mediapipe_face_short", label: "mediapipe_face_short" },
        { kind: "raw", id: "mediapipe_face_mesh", label: "mediapipe_face_mesh" },
      ],
      fallback: "face_yolov8n.pt",
      labelKey: "image_gen_adetailer",
      modelLabelKey: "image_gen_adetailer_model",
      stepsLabelKey: "image_gen_adetailer_steps_label",
      stepsRange: { min: 1, max: 150, step: 1 },
      parseSteps: expect.any(Function),
    });
    if (ready?.state === "ready") {
      expect(ready.parseSteps("")).toEqual({ adetailerSteps: undefined });
      expect(ready.parseSteps("17")).toEqual({ adetailerSteps: 17 });
      expect(ready.parseSteps("17.5")).toBeNull();
    }
    expect(buildAdetailerControl({ backend: "a1111", extensions: ["controlnet"], faceDetectors: [], baseSteps: 20 })).toBeNull();
    expect(buildAdetailerControl({ backend: "a1111", extensions: null, faceDetectors: [], baseSteps: 20 })).toBeNull();
  });

  test("comfyui: an answered detector list is ready with discovered raw options, its first-item fallback, and a dynamic base-steps placeholder", () => {
    expect(
      buildAdetailerControl({
        backend: "comfyui",
        extensions: ["adetailer"],
        faceDetectors: ["bbox/face_yolov8m.pt", "bbox/face_yolov8n.pt"],
        baseSteps: 42,
      }),
    ).toEqual({
      state: "ready",
      options: [
        { kind: "raw", id: "bbox/face_yolov8m.pt", label: "bbox/face_yolov8m.pt" },
        { kind: "raw", id: "bbox/face_yolov8n.pt", label: "bbox/face_yolov8n.pt" },
      ],
      fallback: "bbox/face_yolov8m.pt",
      labelKey: "image_gen_adetailer",
      modelLabelKey: "image_gen_adetailer_model",
      stepsLabelKey: "image_gen_adetailer_steps_label",
      stepsRange: { min: 1, max: 150, step: 1 },
      parseSteps: expect.any(Function),
    });
  });

  test("comfyui: answered-empty is unavailable, while an unanswered or failed probe is hidden", () => {
    expect(buildAdetailerControl({ backend: "comfyui", extensions: null, faceDetectors: [], baseSteps: 20 })).toEqual({
      state: "unavailable",
      labelKey: "image_gen_adetailer",
      hintKey: "image_gen_adetailer_missing_hint",
    });
    expect(buildAdetailerControl({ backend: "comfyui", extensions: null, faceDetectors: null, baseSteps: 20 })).toBeNull();
  });
});

describe("model-controls — buildDitSidecarControls (T3: gate + Auto-pickable + since-removed rules; IF-19 honest Auto + hint)", () => {
  test("returns controls for every ComfyUI DiT workflow family and null otherwise", () => {
    for (const family of ["krea2-dit", "anima-dit", "qwen-image-2.1", "qwen-image", "z-image", "flux-dev", "flux-schnell"]) {
      expect(buildDitSidecarControls({ backend: "comfyui", modelTemplate: family })).not.toBeNull();
    }
    expect(buildDitSidecarControls({ backend: "comfyui", modelTemplate: "checkpoint" })).toBeNull();
    expect(buildDitSidecarControls({ backend: "comfyui", modelTemplate: undefined })).toBeNull();
    expect(buildDitSidecarControls({ backend: "comfyui", modelTemplate: "future-family" })).toBeNull();
    expect(buildDitSidecarControls({ backend: "a1111", modelTemplate: "krea2-dit" })).toBeNull();
    expect(buildDitSidecarControls({ backend: undefined, modelTemplate: "krea2-dit" })).toBeNull();
  });

  test("the manual base-workflow pick outranks the model's template (the executor's order)", () => {
    // A checkpoint-listed model driven through a DiT set gets the fields…
    expect(
      buildDitSidecarControls({ backend: "comfyui", workflowFamily: "qwen-image-2.1", modelTemplate: "checkpoint" }),
    ).not.toBeNull();
    // …and a manual checkpoint pick hides them on a DiT-listed model.
    expect(
      buildDitSidecarControls({ backend: "comfyui", workflowFamily: "checkpoint", modelTemplate: "krea2-dit" }),
    ).toBeNull();
    // The hint follows the manual family, not the template.
    const spec = buildDitSidecarControls({ backend: "comfyui", workflowFamily: "flux-dev", modelTemplate: "krea2-dit" })!;
    expect(spec.hint.params.family).toBe("FLUX.1-dev");
  });

  test("options: the Auto KEY entry heads the list; live names ride raw; a stored off-list value stays pickable exactly once", () => {
    const spec = buildDitSidecarControls({ backend: "comfyui", modelTemplate: "krea2-dit" })!;
    expect(spec.encoder.options(["enc_b.safetensors", "enc_c.safetensors"], undefined)).toEqual([
      { kind: "key", id: "", labelKey: "image_gen_sidecar_auto_missing" },
      { kind: "raw", id: "enc_b.safetensors", label: "enc_b.safetensors" },
      { kind: "raw", id: "enc_c.safetensors", label: "enc_c.safetensors" },
    ]);
    // Since-removed: the stored value is NOT in the live list — appended once.
    expect(spec.vae.options(["vae_b.safetensors"], "vae_removed.safetensors")).toEqual([
      { kind: "key", id: "", labelKey: "image_gen_sidecar_auto_file", params: { file: "vae_b.safetensors" } },
      { kind: "raw", id: "vae_b.safetensors", label: "vae_b.safetensors" },
      { kind: "raw", id: "vae_removed.safetensors", label: "vae_removed.safetensors" },
    ]);
    // A stored value still in the live list is NOT duplicated.
    expect(spec.encoder.options(["enc_b.safetensors"], "enc_b.safetensors")).toHaveLength(2);
  });

  test("Auto names the file the executor's ladder resolves — plain until the list loads, an honest miss when nothing matches", () => {
    const qwen = buildDitSidecarControls({ backend: "comfyui", modelTemplate: "qwen-image-2.1" })!;
    // Not loaded yet: no conclusion from missing data.
    expect(qwen.encoder.options(undefined, undefined)).toEqual([
      { kind: "key", id: "", labelKey: "image_gen_sidecar_auto" },
    ]);
    // Canonical beats an unrelated neighbour; an alias counts as canonical.
    expect(qwen.encoder.options(["qwen3vl_4b.safetensors", "qwen3vl_8b_int8_convrot.safetensors"], undefined)[0]).toEqual({
      kind: "key",
      id: "",
      labelKey: "image_gen_sidecar_auto_file",
      params: { file: "qwen3vl_8b_int8_convrot.safetensors" },
    });
    // Loaded but empty: Auto cannot resolve.
    expect(qwen.vae.options([], undefined)[0]).toEqual({
      kind: "key",
      id: "",
      labelKey: "image_gen_sidecar_auto_missing",
    });
    // Anima: the model's paired `_txt` encoder wins over the canonical file.
    const anima = buildDitSidecarControls({
      backend: "comfyui",
      modelTemplate: "anima-dit",
      modelId: "anima/nijce_1.safetensors",
    })!;
    expect(anima.encoder.options(["qwen_3_06b_base.safetensors", "nijce_1_txt.safetensors"], undefined)[0]).toEqual({
      kind: "key",
      id: "",
      labelKey: "image_gen_sidecar_auto_file",
      params: { file: "nijce_1_txt.safetensors" },
    });
  });

  test("hint: the family label + the files it needs, from the domain's one sidecar source", () => {
    expect(buildDitSidecarControls({ backend: "comfyui", modelTemplate: "qwen-image-2.1" })!.hint).toEqual({
      labelKey: "image_gen_sidecar_hint",
      params: {
        family: "Qwen Image 2.1",
        encoder: "qwen3vl_8b / qwen3vl_8b_int8_convrot",
        vae: "qwen_image_2.1_vae / qwen_image_2.1_vae_bf16",
      },
    });
    // FLUX's always-automatic second encoder joins with " + ".
    expect(buildDitSidecarControls({ backend: "comfyui", modelTemplate: "flux-schnell" })!.hint.params).toEqual({
      family: "FLUX.1-schnell",
      encoder: "clip_l + t5xxl_fp16",
      vae: "ae / fluxVAE",
    });
    // Anima names the paired stem first once a model is picked.
    expect(
      buildDitSidecarControls({ backend: "comfyui", modelTemplate: "anima-dit", modelId: "nijce_1.safetensors" })!.hint.params
        .encoder,
    ).toBe("nijce_1_txt / qwen_3_06b_base");
  });

  test("translateModelOptions passes the Auto entry's params to t", () => {
    const spec = buildDitSidecarControls({ backend: "comfyui", modelTemplate: "krea2-dit" })!;
    const t = (key: string, params?: Record<string, unknown>) =>
      params === undefined ? key : `${key}:${String(params.file)}`;
    expect(translateModelOptions(spec.vae.options(["qwen_image_vae.safetensors"], undefined), t)[0]).toEqual({
      id: "",
      label: "image_gen_sidecar_auto_file:qwen_image_vae.safetensors",
    });
  });

  test("commit: Auto (\"\") inherits (undefined); a file name commits it — per field", () => {
    const spec = buildDitSidecarControls({ backend: "comfyui", modelTemplate: "krea2-dit" })!;
    expect(spec.encoder.commit("")).toEqual({ encoderName: undefined });
    expect(spec.encoder.commit("enc_b.safetensors")).toEqual({ encoderName: "enc_b.safetensors" });
    expect(spec.vae.commit("")).toEqual({ vaeName: undefined });
    expect(spec.vae.commit("vae_b.safetensors")).toEqual({ vaeName: "vae_b.safetensors" });
  });
});
