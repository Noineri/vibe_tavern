import { describe, expect, it } from "bun:test";

import {
  COMFY_TEMPLATE_SPECS,
  resolveComfySidecar,
} from "../src/domain/imagegen/backends/comfy-workflow-templates.js";

function resolveSidecar(
  names: readonly string[],
  overrides: Partial<{
    explicit: string | undefined;
    canonical: string;
    folder: string;
    what: string;
    pairedStem: string | undefined;
  }> = {},
  spec = COMFY_TEMPLATE_SPECS.krea2Dit,
) {
  let folderCalls = 0;
  const result = resolveComfySidecar(
    {
      folder: overrides.folder ?? "text_encoders",
      explicit: overrides.explicit,
      canonical: overrides.canonical ?? COMFY_TEMPLATE_SPECS.krea2Dit.canonicalEncoder,
      pairedStem: overrides.pairedStem,
      what: overrides.what ?? "text encoder",
      signal: undefined,
      listFolder: async () => {
        folderCalls += 1;
        return names;
      },
      createConfigError: (message) => new Error(message),
    },
    spec,
  );
  return { result, folderCalls: () => folderCalls };
}

describe("Comfy workflow template registry", () => {
  it("declares the checkpoint and Krea-2 template data exactly", () => {
    expect(COMFY_TEMPLATE_SPECS.checkpoint).toEqual({
      id: "checkpoint",
      familyLabel: "Checkpoint",
    });
    expect(COMFY_TEMPLATE_SPECS.krea2Dit).toEqual({
      id: "krea2-dit",
      familyLabel: "Krea-2",
      clipType: "krea2",
      canonicalEncoder: "qwen3vl_4b_fp8_scaled",
      canonicalVae: "qwen_image_vae",
    });
    expect(COMFY_TEMPLATE_SPECS.animaDit).toEqual({
      id: "anima-dit",
      familyLabel: "Anima",
      clipType: "stable_diffusion",
      canonicalEncoder: "qwen_3_06b_base",
      canonicalVae: "qwen_image_vae",
      encoderPairedStem: true,
    });
  });

  it("uses the explicit sidecar without listing its folder", async () => {
    const sidecar = resolveSidecar(["qwen3vl_4b_fp8_scaled.safetensors"], { explicit: " chosen.safetensors " });

    await expect(sidecar.result).resolves.toBe("chosen.safetensors");
    expect(sidecar.folderCalls()).toBe(0);
  });

  it("matches the canonical basename across extensions and subfolders", async () => {
    const sidecar = resolveSidecar(["other.safetensors", "nested/qwen3vl_4b_fp8_scaled.gguf"]);

    await expect(sidecar.result).resolves.toBe("nested/qwen3vl_4b_fp8_scaled.gguf");
    expect(sidecar.folderCalls()).toBe(1);
  });

  it("resolves an Anima encoder in paired-stem, canonical, then sole-file order", async () => {
    const paired = resolveSidecar(
      ["qwen_3_06b_base.safetensors", "nijce_1_txt.safetensors"],
      { canonical: "qwen_3_06b_base", pairedStem: "nijce_1.safetensors" },
      COMFY_TEMPLATE_SPECS.animaDit,
    );
    await expect(paired.result).resolves.toBe("nijce_1_txt.safetensors");

    const canonical = resolveSidecar(
      ["other.safetensors", "qwen_3_06b_base.safetensors"],
      { canonical: "qwen_3_06b_base", pairedStem: "homosimileAnima_v20.safetensors" },
      COMFY_TEMPLATE_SPECS.animaDit,
    );
    await expect(canonical.result).resolves.toBe("qwen_3_06b_base.safetensors");

    const sole = resolveSidecar(
      ["custom_encoder.safetensors"],
      { canonical: "qwen_3_06b_base", pairedStem: "homosimileAnima_v20.safetensors" },
      COMFY_TEMPLATE_SPECS.animaDit,
    );
    await expect(sole.result).resolves.toBe("custom_encoder.safetensors");
  });

  it("uses the folder's sole sidecar when the canonical file is absent", async () => {
    const sidecar = resolveSidecar(["custom_encoder.safetensors"]);

    await expect(sidecar.result).resolves.toBe("custom_encoder.safetensors");
  });

  it("fails closed with the registry family label when several candidates remain", async () => {
    const sidecar = resolveSidecar(["first.safetensors", "second.safetensors"]);

    await expect(sidecar.result).rejects.toThrow(
      'ComfyUI text encoder for the Krea-2 template is unresolved: no "qwen3vl_4b_fp8_scaled.*" in the text_encoders folder (candidates: first.safetensors, second.safetensors) — pick one in the profile\'s advanced fields',
    );
  });
});
