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
