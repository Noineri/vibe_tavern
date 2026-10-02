import { describe, expect, test } from "bun:test";

import {
  IMAGE_GEN_STOCK_SAMPLER_SET_IDS,
  IMAGE_GEN_WORKFLOW_FAMILY_DEFAULTS,
  IMAGE_GEN_WORKFLOW_FAMILY_IDS,
  IMAGE_GEN_WORKFLOW_FAMILY_SIDECARS,
  imageGenSidecarCandidates,
  imageGenStockSamplerSets,
  isImageGenDitWorkflowFamily,
  pickImageGenSidecar,
} from "../src/index.js";

describe("image-gen workflow families", () => {
  test("publishes the closed workflow set and official fleet defaults", () => {
    expect(IMAGE_GEN_WORKFLOW_FAMILY_IDS).toEqual([
      "qwen-image-2.1",
      "qwen-image",
      "z-image",
      "flux-dev",
      "flux-schnell",
      "krea2-dit",
      "anima-dit",
      "checkpoint",
    ]);
    expect(IMAGE_GEN_WORKFLOW_FAMILY_DEFAULTS).toEqual({
      "qwen-image-2.1": { steps: 25, cfg: 1, sampler: "euler", scheduler: "simple" },
      "qwen-image": { steps: 20, cfg: 4, sampler: "euler", scheduler: "simple" },
      "z-image": { steps: 8, cfg: 1, sampler: "res_multistep", scheduler: "simple" },
      "z-image-base": { steps: 25, cfg: 4, sampler: "res_multistep", scheduler: "simple" },
      "flux-dev": { steps: 20, cfg: 1, sampler: "euler", scheduler: "simple" },
      "flux-schnell": { steps: 4, cfg: 1, sampler: "euler", scheduler: "simple" },
    });
  });

  test("fleet stock rows derive their scalars and leave sidecars automatic", () => {
    const rows = imageGenStockSamplerSets();
    const fleet = [
      ["qwenImage21", "qwen-image-2.1", "qwen-image-2.1"],
      ["qwenImage", "qwen-image", "qwen-image"],
      ["zImageTurbo", "z-image", "z-image"],
      ["zImageBase", "z-image-base", "z-image"],
      ["fluxDev", "flux-dev", "flux-dev"],
      ["fluxSchnell", "flux-schnell", "flux-schnell"],
    ] as const;

    for (const [idKey, defaultsKey, workflowFamily] of fleet) {
      const row = rows.find((candidate) => candidate.id === IMAGE_GEN_STOCK_SAMPLER_SET_IDS[idKey]);
      const defaults = IMAGE_GEN_WORKFLOW_FAMILY_DEFAULTS[defaultsKey];
      expect(row?.payload).toEqual({
        steps: defaults.steps,
        cfgScale: defaults.cfg,
        sampler: defaults.sampler,
        scheduler: defaults.scheduler,
        adetailer: false,
        workflowFamily,
      });
      expect(row?.payload.encoderName).toBeUndefined();
      expect(row?.payload.vae).toBeUndefined();
    }
  });
});

describe("image-gen workflow sidecars (IF-19 single source)", () => {
  test("covers exactly the DiT families — every workflow id except checkpoint", () => {
    expect(Object.keys(IMAGE_GEN_WORKFLOW_FAMILY_SIDECARS).sort()).toEqual(
      IMAGE_GEN_WORKFLOW_FAMILY_IDS.filter((id) => id !== "checkpoint").sort(),
    );
    expect(isImageGenDitWorkflowFamily("flux-dev")).toBe(true);
    expect(isImageGenDitWorkflowFamily("checkpoint")).toBe(false);
    expect(isImageGenDitWorkflowFamily("toString")).toBe(false);
    expect(isImageGenDitWorkflowFamily(undefined)).toBe(false);
  });

  test("candidates: paired stem (with a model) → canonical → aliases", () => {
    const anima = IMAGE_GEN_WORKFLOW_FAMILY_SIDECARS["anima-dit"].encoder;
    expect(imageGenSidecarCandidates(anima)).toEqual(["qwen_3_06b_base"]);
    expect(imageGenSidecarCandidates(anima, "sub/nijce_1.safetensors")).toEqual(["nijce_1_txt", "qwen_3_06b_base"]);
    expect(imageGenSidecarCandidates(IMAGE_GEN_WORKFLOW_FAMILY_SIDECARS["z-image"].vae)).toEqual(["ae", "fluxVAE"]);
  });

  test("pick: paired stem, then the first listed canonical-or-alias file, then a lone file, else undefined", () => {
    const anima = IMAGE_GEN_WORKFLOW_FAMILY_SIDECARS["anima-dit"].encoder;
    expect(pickImageGenSidecar(["qwen_3_06b_base.safetensors", "nijce_1_txt.safetensors"], anima, "nijce_1.safetensors"))
      .toBe("nijce_1_txt.safetensors");
    expect(pickImageGenSidecar(["qwen_3_06b_base.safetensors", "other.safetensors"], anima, "nijce_1.safetensors"))
      .toBe("qwen_3_06b_base.safetensors");
    const zVae = IMAGE_GEN_WORKFLOW_FAMILY_SIDECARS["z-image"].vae;
    // Listing order decides between the canonical file and an alias (the executor's pre-IF-19 rule).
    expect(pickImageGenSidecar(["fluxVAE.safetensors", "ae.safetensors"], zVae)).toBe("fluxVAE.safetensors");
    expect(pickImageGenSidecar(["lonely.safetensors"], zVae)).toBe("lonely.safetensors");
    expect(pickImageGenSidecar(["a.safetensors", "b.safetensors"], zVae)).toBeUndefined();
    expect(pickImageGenSidecar([], zVae)).toBeUndefined();
  });
});
