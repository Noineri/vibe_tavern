/**
 * Unit tests for the image-gen backend registry — mirrors stt-registry.test.ts.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";
import type { ImageGenBackendType } from "@vibe-tavern/domain";
import {
  IMAGE_GEN_BACKEND_CAPABILITIES,
  getImageGenBackendCapabilities,
  createImageGenBackend,
  registerImageGenBackend,
  listImageGenBackendSlugs,
  ImageGenUnknownBackendError,
  ImageGenBackendNotRegisteredError,
  __resetImageGenRegistryForTests,
  __snapshotImageGenRegistryForTests,
  __restoreImageGenRegistryForTests,
} from "../src/domain/imagegen/imagegen-registry.js";
import type { ImageGenBackend } from "../src/domain/imagegen/imagegen-registry.js";

const ALL_SLUGS = Object.values(IMAGE_GEN_BACKENDS) as ImageGenBackendType[];

const A1111_CONFIG = {
  endpoint: "http://127.0.0.1:7860",
};

// Snapshot BEFORE the first reset — shared-process rule, see tts-registry.test.ts.
const registrySnapshot = __snapshotImageGenRegistryForTests();

beforeEach(() => {
  __resetImageGenRegistryForTests();
});

afterAll(() => {
  __restoreImageGenRegistryForTests(registrySnapshot);
});

describe("imagegen registry", () => {
  describe("getImageGenBackendCapabilities", () => {
    it("returns an object with exactly the 8 flag keys for every slug", () => {
      for (const slug of ALL_SLUGS) {
        const caps = getImageGenBackendCapabilities(slug);
        expect(Object.keys(caps).sort()).toEqual(
          [
            "supportsNegativePrompt",
            "supportsSamplers",
            "supportsSeed",
            "sizeSupport",
            "noApiKey",
            "supportsLiveProgress",
            "supportsImg2img",
            "supportsInpaint",
          ].sort(),
        );
      }
    });

    it("declares boolean flags as booleans and sizeSupport as a valid union member for every slug", () => {
      for (const slug of ALL_SLUGS) {
        const caps = getImageGenBackendCapabilities(slug);
        for (const flag of [
          "supportsNegativePrompt",
          "supportsSamplers",
          "supportsSeed",
          "noApiKey",
          "supportsLiveProgress",
          "supportsImg2img",
          "supportsInpaint",
        ] as const) {
          expect(typeof caps[flag]).toBe("boolean");
        }
        if (caps.sizeSupport.kind === "vendor-set") {
          for (const size of caps.sizeSupport.sizes) {
            expect(size).toMatch(/^\d+x\d+$/);
          }
        } else {
          expect(caps.sizeSupport.kind).toBe("free");
        }
      }
    });

    it("has the v1 flag values (cloud cards vs the A1111 local card)", () => {
      const openrouter = getImageGenBackendCapabilities(IMAGE_GEN_BACKENDS.OpenRouter);
      expect(openrouter.supportsNegativePrompt).toBe(false);
      expect(openrouter.supportsSamplers).toBe(false);
      expect(openrouter.supportsSeed).toBe(false);
      expect(openrouter.noApiKey).toBe(false);
      expect(openrouter.supportsLiveProgress).toBe(false);
      expect(openrouter.sizeSupport.kind).toBe("vendor-set");

      const openaiImages = getImageGenBackendCapabilities(IMAGE_GEN_BACKENDS.OpenAiImages);
      expect(openaiImages.supportsNegativePrompt).toBe(false);
      expect(openaiImages.supportsSamplers).toBe(false);
      expect(openaiImages.supportsSeed).toBe(false);
      expect(openaiImages.noApiKey).toBe(false);
      expect(openaiImages.sizeSupport).toEqual({
        kind: "vendor-set",
        sizes: ["1024x1024", "1536x1024", "1024x1536"],
      });

      const a1111 = getImageGenBackendCapabilities(IMAGE_GEN_BACKENDS.A1111);
      expect(a1111.supportsNegativePrompt).toBe(true);
      expect(a1111.supportsSamplers).toBe(true);
      expect(a1111.supportsSeed).toBe(true);
      expect(a1111.noApiKey).toBe(true);
      expect(a1111.supportsLiveProgress).toBe(true);
      expect(a1111.sizeSupport).toEqual({ kind: "free" });

      // Reserved flags stay stamped off across the whole v1 roster.
      for (const slug of ALL_SLUGS) {
        expect(getImageGenBackendCapabilities(slug).supportsImg2img).toBe(false);
        expect(getImageGenBackendCapabilities(slug).supportsInpaint).toBe(false);
      }
    });
  });

  describe("createImageGenBackend", () => {
    it("throws ImageGenUnknownBackendError for an unknown slug (message includes the slug)", () => {
      expect(() => createImageGenBackend("nope", A1111_CONFIG)).toThrow(ImageGenUnknownBackendError);
      expect(() => createImageGenBackend("nope", A1111_CONFIG)).toThrow(/nope/);
    });

    it("throws ImageGenBackendNotRegisteredError for a known slug with no factory", () => {
      expect(() => createImageGenBackend(IMAGE_GEN_BACKENDS.A1111, A1111_CONFIG)).toThrow(
        ImageGenBackendNotRegisteredError,
      );
    });

    it("returns the stub instance and passes config verbatim after registration", () => {
      const stub: ImageGenBackend = {
        probe: async () => ({ ok: true }),
        listModels: async () => [],
        generate: async () => ({ images: [] }),
        dispose: async () => {},
      };
      let receivedConfig: unknown;
      registerImageGenBackend(IMAGE_GEN_BACKENDS.A1111, (config) => {
        receivedConfig = config;
        return stub;
      });

      const backend = createImageGenBackend(IMAGE_GEN_BACKENDS.A1111, A1111_CONFIG);
      expect(backend).toBe(stub);
      expect(receivedConfig).toEqual(A1111_CONFIG);
    });

    it("registerImageGenBackend rejects an unknown slug", () => {
      expect(() =>
        registerImageGenBackend("nope" as ImageGenBackendType, () => ({
          probe: async () => ({ ok: true }),
          listModels: async () => [],
          generate: async () => ({ images: [] }),
          dispose: async () => {},
        })),
      ).toThrow(ImageGenUnknownBackendError);
    });
  });

  describe("listImageGenBackendSlugs", () => {
    it("contains exactly the three v1 slugs", () => {
      expect(listImageGenBackendSlugs().sort()).toEqual([...ALL_SLUGS].sort());
      expect(ALL_SLUGS).toHaveLength(3);
    });
  });

  describe("IMAGE_GEN_BACKEND_CAPABILITIES (static map)", () => {
    it("is exhaustive over the roster (typecheck-enforced; runtime-verified)", () => {
      expect(Object.keys(IMAGE_GEN_BACKEND_CAPABILITIES).sort()).toEqual([...ALL_SLUGS].sort());
    });
  });
});
