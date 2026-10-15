/**
 * Pure tests for the client-side auto-key mirror
 * (`matchImageGenAutoKeyProviderName`) — the hint rule the editor shows for
 * a keyless draft. Mirrors the server matcher in
 * services/api/src/api/adapters/image-gen-auto-key.ts (T0: no doubles).
 */

import { describe, expect, it } from "bun:test";
import { IMAGE_GEN_BACKENDS } from "@vibe-tavern/domain";

import { matchImageGenAutoKeyProviderName } from "./imagegen-form-helpers.js";

const keyful = (name: string, endpoint: string) => ({ name, endpoint, hasStoredApiKey: true });

describe("matchImageGenAutoKeyProviderName", () => {
  it("matches the exact endpoint of a keyful provider; keyless providers never match", () => {
    const providers = [
      { name: "No key", endpoint: "https://api.closerouter.dev/v1", hasStoredApiKey: false },
      keyful("closerouter", "https://api.closerouter.dev/v1"),
    ];
    expect(
      matchImageGenAutoKeyProviderName(IMAGE_GEN_BACKENDS.OpenAiImages, "https://api.closerouter.dev/v1", providers),
    ).toBe("closerouter");
  });

  it("local dialects never match; an empty endpoint never matches", () => {
    const providers = [keyful("local", "http://127.0.0.1:7860")];
    expect(matchImageGenAutoKeyProviderName(IMAGE_GEN_BACKENDS.A1111, "http://127.0.0.1:7860", providers)).toBeNull();
    expect(matchImageGenAutoKeyProviderName(IMAGE_GEN_BACKENDS.ComfyUI, "http://127.0.0.1:7860", providers)).toBeNull();
    expect(matchImageGenAutoKeyProviderName(IMAGE_GEN_BACKENDS.OpenAiImages, "  ", providers)).toBeNull();
  });

  it("openrouter matches a provider on the vendor host whatever the profile endpoint says", () => {
    const providers = [keyful("OR main", "https://openrouter.ai/api/v1")];
    expect(matchImageGenAutoKeyProviderName(IMAGE_GEN_BACKENDS.OpenRouter, "", providers)).toBe("OR main");
  });

  it("host rule: /v1, bare host, trailing slash and any path on the same host all match (owner 2026-10-15)", () => {
    const providers = [keyful("closerouter", "https://api.closerouter.dev/v1")];
    for (const endpoint of [
      "https://api.closerouter.dev",
      "https://api.closerouter.dev/",
      "api.closerouter.dev/v1/",
      "https://API.closerouter.dev/v2/images",
    ]) {
      expect(matchImageGenAutoKeyProviderName(IMAGE_GEN_BACKENDS.OpenAiImages, endpoint, providers)).toBe("closerouter");
    }
  });

  it("host rule: a different host or a different port never matches", () => {
    const providers = [keyful("closerouter", "https://api.closerouter.dev/v1"), keyful("local", "http://localhost:8000/v1")];
    expect(
      matchImageGenAutoKeyProviderName(IMAGE_GEN_BACKENDS.OpenAiImages, "https://closerouter.dev/v1", providers),
    ).toBeNull();
    expect(matchImageGenAutoKeyProviderName(IMAGE_GEN_BACKENDS.OpenAiImages, "http://localhost:9000/v1", providers)).toBeNull();
  });

  it("two keyful providers on one host: the FIRST in list order wins", () => {
    const providers = [keyful("first", "https://api.closerouter.dev/v1"), keyful("second", "https://api.closerouter.dev")];
    expect(matchImageGenAutoKeyProviderName(IMAGE_GEN_BACKENDS.OpenAiImages, "https://api.closerouter.dev", providers)).toBe(
      "first",
    );
  });
});
