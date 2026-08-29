import { describe, expect, it } from "bun:test";
import { matchAutoKeyProviderName, normalizeTtsEndpoint } from "./tts-form-helpers.js";

// D21: the client-side auto-key mirror must behave EXACTLY like the server's
// autoMatchProviderKey (services/api tts-adapter) — the hint promises what
// the server will resolve, so a drift here is a false promise in the UI.

describe("normalizeTtsEndpoint", () => {
  it("mirrors the server normalization: trim, https:// prefix, trailing slash, lowercase", () => {
    expect(normalizeTtsEndpoint("  https://Nano-GPT.com/api/v1//  ")).toBe("https://nano-gpt.com/api/v1");
    expect(normalizeTtsEndpoint("nano-gpt.com/api/v1/")).toBe("https://nano-gpt.com/api/v1");
    expect(normalizeTtsEndpoint("http://localhost:8080/v1/")).toBe("http://localhost:8080/v1");
  });
});

describe("matchAutoKeyProviderName", () => {
  it("resolves the FIRST keyful provider whose endpoint matches (server list order)", () => {
    const providers = [
      { endpoint: "https://nano-gpt.com/api/v1", hasStoredApiKey: true, name: "NanoLLM" },
      { endpoint: "https://nano-gpt.com/api/v1/", hasStoredApiKey: true, name: "NanoSecond" },
    ];
    expect(matchAutoKeyProviderName("nano-gpt.com/api/v1", providers)).toBe("NanoLLM");
  });

  it("skips keyless providers and returns null on no match / empty endpoint", () => {
    const providers = [
      { endpoint: "https://nano-gpt.com/api/v1", hasStoredApiKey: false, name: "NoKey" },
      { endpoint: "https://elsewhere.example/v1", hasStoredApiKey: true, name: "Else" },
    ];
    expect(matchAutoKeyProviderName("https://nano-gpt.com/api/v1", providers)).toBeNull();
    expect(matchAutoKeyProviderName("", providers)).toBeNull();
    expect(matchAutoKeyProviderName(null, providers)).toBeNull();
    expect(matchAutoKeyProviderName(undefined, providers)).toBeNull();
  });
});
