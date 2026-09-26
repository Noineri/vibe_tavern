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
  }> = {},
) {
  let folderCalls = 0;
  const result = resolveComfySidecar(
    {
      folder: overrides.folder ?? "text_encoders",
      explicit: overrides.explicit,
      canonical: overrides.canonical ?? COMFY_TEMPLATE_SPECS.krea2Dit.canonicalEncoder,
      what: overrides.what ?? "text encoder",
      signal: undefined,
      listFolder: async () => {
        folderCalls += 1;
        return names;
      },
      createConfigError: (message) => new Error(message),
    },
    COMFY_TEMPLATE_SPECS.krea2Dit,
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
