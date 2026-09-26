import { describe, expect, test } from "bun:test";

import {
  IMAGE_GEN_STOCK_SAMPLER_SET_IDS,
  IMAGE_GEN_WORKFLOW_FAMILY_DEFAULTS,
  IMAGE_GEN_WORKFLOW_FAMILY_IDS,
  imageGenStockSamplerSets,
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
