/**
 * Unit tests for the STT backend registry — mirrors tts-registry.test.ts.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { STT_BACKENDS } from "@vibe-tavern/domain";
import type { SttBackendType } from "@vibe-tavern/domain";
import {
  getSttBackendCapabilities,
  createSttBackend,
  registerSttBackend,
  listSttBackendSlugs,
  SttUnknownBackendError,
  SttBackendNotRegisteredError,
  __resetSttRegistryForTests,
} from "../src/domain/stt/stt-registry.js";
import type { SttBackend } from "../src/domain/stt/stt-backend.js";

const ALL_SLUGS = Object.values(STT_BACKENDS) as SttBackendType[];

const OPENAI_COMPAT_CONFIG = {
  endpoint: "http://localhost:8000/v1",
  model: "whisper-1",
};

beforeEach(() => {
  __resetSttRegistryForTests();
});

describe("stt registry", () => {
  describe("getSttBackendCapabilities", () => {
    it("returns an object with exactly the 5 flag keys for every slug", () => {
      for (const slug of ALL_SLUGS) {
        const caps = getSttBackendCapabilities(slug);
        expect(Object.keys(caps).sort()).toEqual(
          [
            "emotionAnnotation",
            "openaiCompatible",
            "requiresApiKey",
            "supportsStreaming",
            "transport",
          ].sort(),
        );
      }
    });

    it("declares the four capability flags as booleans and transport as a string for every slug", () => {
      for (const slug of ALL_SLUGS) {
        const caps = getSttBackendCapabilities(slug);
        expect(typeof caps.transport).toBe("string");
        for (const flag of [
          "openaiCompatible",
          "supportsStreaming",
          "emotionAnnotation",
          "requiresApiKey",
        ] as const) {
          expect(typeof caps[flag]).toBe("boolean");
        }
      }
    });

    it("has the v1 flag values", () => {
      const whisper = getSttBackendCapabilities(STT_BACKENDS.WhisperBrowser);
      expect(whisper.transport).toBe("client");
      expect(whisper.openaiCompatible).toBe(false);
      expect(whisper.supportsStreaming).toBe(false);
      expect(whisper.emotionAnnotation).toBe(false);
      expect(whisper.requiresApiKey).toBe(false);

      const openai = getSttBackendCapabilities(STT_BACKENDS.OpenAiCompat);
      expect(openai.transport).toBe("server");
      expect(openai.openaiCompatible).toBe(true);
      expect(openai.supportsStreaming).toBe(false);
      expect(openai.emotionAnnotation).toBe(false);
      expect(openai.requiresApiKey).toBe(true);
    });
  });

  describe("createSttBackend", () => {
    it("throws SttUnknownBackendError for an unknown slug (message includes the slug)", () => {
      expect(() => createSttBackend("nope", { model: "whisper-1" })).toThrow(
        SttUnknownBackendError,
      );
      expect(() => createSttBackend("nope", { model: "whisper-1" })).toThrow(/nope/);
    });

    it("throws SttBackendNotRegisteredError for a known slug with no factory", () => {
      expect(() => createSttBackend(STT_BACKENDS.OpenAiCompat, OPENAI_COMPAT_CONFIG)).toThrow(
        SttBackendNotRegisteredError,
      );
    });

    it("returns the stub instance and passes config verbatim after registration", () => {
      const stub: SttBackend = {
        transcribe: async () => ({ text: "hello" }),
        probe: async () => ({ ok: true }),
        dispose: async () => {},
      };
      let receivedConfig: unknown;
      registerSttBackend(STT_BACKENDS.OpenAiCompat, (config) => {
        receivedConfig = config;
        return stub;
      });

      const backend = createSttBackend(STT_BACKENDS.OpenAiCompat, OPENAI_COMPAT_CONFIG);
      expect(backend).toBe(stub);
      expect(receivedConfig).toEqual(OPENAI_COMPAT_CONFIG);
    });
  });

  describe("listSttBackendSlugs", () => {
    it("contains both v1 slugs", () => {
      const slugs = listSttBackendSlugs();
      expect(slugs.sort()).toEqual([...ALL_SLUGS].sort());
    });
  });
});
