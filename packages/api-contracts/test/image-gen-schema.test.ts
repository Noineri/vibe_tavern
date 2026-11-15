import { describe, expect, test } from "bun:test";

import {
  generateImageGenSchema,
  imageGenSamplerSetPayloadSchema,
} from "../src/schemas/image-gen-schema.js";

describe("image-gen workflow family schemas", () => {
  test("accepts closed workflow ids in sampler sets and per-run overrides", () => {
    expect(
      imageGenSamplerSetPayloadSchema.safeParse({
        encoderName: "qwen3vl_8b.safetensors",
        vae: "qwen_image_2.1_vae.safetensors",
        workflowFamily: "qwen-image-2.1",
      }).success,
    ).toBe(true);
    expect(
      generateImageGenSchema.safeParse({
        profileId: "profile-1",
        mode: "portrait",
        overrides: { workflowFamily: "flux-schnell" },
      }).success,
    ).toBe(true);
  });

  test("accepts cfgRescale 0..1 boundaries and rejects out-of-range values on both boundaries", () => {
    for (const cfgRescale of [0, 0.6, 1]) {
      const sampler = imageGenSamplerSetPayloadSchema.safeParse({ cfgRescale });
      expect(sampler.success).toBe(true);
      if (sampler.success) expect(sampler.data.cfgRescale).toBe(cfgRescale);

      const gen = generateImageGenSchema.safeParse({
        profileId: "profile-1",
        mode: "portrait",
        overrides: { cfgRescale },
      });
      expect(gen.success).toBe(true);
      if (gen.success) expect(gen.data.overrides?.cfgRescale).toBe(cfgRescale);
    }

    for (const cfgRescale of [-0.01, 1.01]) {
      expect(imageGenSamplerSetPayloadSchema.safeParse({ cfgRescale }).success).toBe(false);
      expect(
        generateImageGenSchema.safeParse({
          profileId: "profile-1",
          mode: "portrait",
          overrides: { cfgRescale },
        }).success,
      ).toBe(false);
    }
  });

  test("rejects unknown workflow ids at both wire boundaries", () => {
    expect(imageGenSamplerSetPayloadSchema.safeParse({ workflowFamily: "made-up" }).success).toBe(false);
    expect(
      generateImageGenSchema.safeParse({
        profileId: "profile-1",
        mode: "portrait",
        overrides: { workflowFamily: "made-up" },
      }).success,
    ).toBe(false);
  });
});
