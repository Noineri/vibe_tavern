/**
 * Unit tests for the TTS backend registry — mirrors protocol-registry.test.ts.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { TTS_BACKEND } from "@vibe-tavern/domain";
import type { TtsBackendSlug } from "@vibe-tavern/domain";
import {
  getTtsBackendCapabilities,
  createTtsBackend,
  registerTtsBackend,
  listTtsBackendSlugs,
  TtsUnknownBackendError,
  TtsBackendNotRegisteredError,
  __resetTtsRegistryForTests,
} from "../src/domain/tts/tts-registry.js";
import { classifyOpenAiCompatTransport } from "@vibe-tavern/domain";
import type { TtsBackend } from "../src/domain/tts/tts-backend.js";

const ALL_SLUGS = Object.values(TTS_BACKEND) as TtsBackendSlug[];

beforeEach(() => {
  __resetTtsRegistryForTests();
});

describe("tts registry", () => {
  describe("getTtsBackendCapabilities", () => {
    it("returns an object with exactly the 7 keys for every slug", () => {
      for (const slug of ALL_SLUGS) {
        const caps = getTtsBackendCapabilities(slug);
        expect(Object.keys(caps).sort()).toEqual(
          ["openaiCompatible", "requiresApiKey", "supportsCloning", "supportsSpeed", "supportsStreaming", "supportsVoiceList", "transport"].sort(),
        );
      }
    });

    it("has the v1 flag values", () => {
      const kokoro = getTtsBackendCapabilities(TTS_BACKEND.Kokoro);
      expect(kokoro.transport).toBe("inbrowser");
      expect(kokoro.openaiCompatible).toBe(false);
      expect(kokoro.supportsStreaming).toBe(true);
      expect(kokoro.supportsCloning).toBe(false);
      expect(kokoro.supportsVoiceList).toBe(true);
      expect(kokoro.supportsSpeed).toBe(true);
      expect(kokoro.requiresApiKey).toBe(false);

      const openai = getTtsBackendCapabilities(TTS_BACKEND.OpenAiCompatible);
      expect(openai.transport).toBe("local");
      expect(openai.openaiCompatible).toBe(true);
      expect(openai.supportsStreaming).toBe(true);
      expect(openai.supportsCloning).toBe(false);
      expect(openai.supportsVoiceList).toBe(true);
      expect(openai.supportsSpeed).toBe(true);
      expect(openai.requiresApiKey).toBe(false);

      const gemini = getTtsBackendCapabilities(TTS_BACKEND.Gemini);
      expect(gemini.transport).toBe("cloud");
      expect(gemini.openaiCompatible).toBe(false);
      expect(gemini.supportsStreaming).toBe(false);
      expect(gemini.supportsCloning).toBe(false);
      expect(gemini.supportsVoiceList).toBe(true);
      expect(gemini.supportsSpeed).toBe(false);
      expect(gemini.requiresApiKey).toBe(true);

      const eleven = getTtsBackendCapabilities(TTS_BACKEND.ElevenLabs);
      expect(eleven.transport).toBe("cloud");
      expect(eleven.openaiCompatible).toBe(false);
      expect(eleven.supportsStreaming).toBe(false);
      expect(eleven.supportsCloning).toBe(false);
      expect(eleven.supportsVoiceList).toBe(true);
      expect(eleven.supportsSpeed).toBe(true);
      expect(eleven.requiresApiKey).toBe(true);
    });
  });

  describe("createTtsBackend", () => {
    it("throws TtsUnknownBackendError for an unknown slug (message includes the slug)", () => {
      expect(() => createTtsBackend("nope", {})).toThrow(TtsUnknownBackendError);
      expect(() => createTtsBackend("nope", {})).toThrow(/nope/);
    });

    it("throws TtsBackendNotRegisteredError for a known slug with no factory", () => {
      expect(() => createTtsBackend(TTS_BACKEND.Gemini, {})).toThrow(TtsBackendNotRegisteredError);
    });

    it("returns the stub instance and passes config verbatim after registration", () => {
      const stub: TtsBackend = {
        generate: async () => ({ audio: Buffer.from("hi"), mime: "audio/wav" }),
        listVoices: async () => [],
        probe: async () => ({ ok: true }),
        dispose: async () => {},
      };
      let receivedConfig: unknown;
      registerTtsBackend(TTS_BACKEND.Gemini, (config) => {
        receivedConfig = config;
        return stub;
      });

      const config = { some: "cfg" };
      const backend = createTtsBackend(TTS_BACKEND.Gemini, config);
      expect(backend).toBe(stub);
      expect(receivedConfig).toEqual(config);
    });
  });

  describe("classifyOpenAiCompatTransport", () => {
    it("classifies loopback hosts as local", () => {
      expect(classifyOpenAiCompatTransport("http://localhost:8880/v1")).toBe("local");
      expect(classifyOpenAiCompatTransport("http://127.0.0.1:8000")).toBe("local");
      expect(classifyOpenAiCompatTransport("http://[::1]:5050/v1")).toBe("local");
      expect(classifyOpenAiCompatTransport("http://LOCALHOST:8880/v1")).toBe("local");
    });

    it("classifies non-loopback hosts as cloud", () => {
      expect(classifyOpenAiCompatTransport("https://openrouter.ai/api/v1")).toBe("cloud");
      expect(classifyOpenAiCompatTransport("https://api.openai.com/v1")).toBe("cloud");
      expect(classifyOpenAiCompatTransport("http://192.168.1.10:8880/v1")).toBe("cloud");
    });

    it("returns cloud for invalid URLs", () => {
      expect(classifyOpenAiCompatTransport("not a url")).toBe("cloud");
      expect(classifyOpenAiCompatTransport("")).toBe("cloud");
    });
  });

  describe("listTtsBackendSlugs", () => {
    it("contains all four slugs", () => {
      const slugs = listTtsBackendSlugs();
      expect(slugs.sort()).toEqual([...ALL_SLUGS].sort());
    });
  });
});
