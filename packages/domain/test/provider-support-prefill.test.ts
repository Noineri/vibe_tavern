/**
 * LS-4 capability gates in provider-support.ts — the shared fail-closed
 * prefill resolution (web + API read the SAME function).
 *
 * WHAT THIS PROVES
 *   - `resolveAssistantPrefillSupport` mirrors the backend protocol registry's
 *     `capabilities.prefill` flags exactly (inverted): anthropic / google /
 *     google_interactions / koboldcpp are OFF; the OpenAI-compat family
 *     (cloud AND local ids), llamacpp, ollama, unsloth are ON. This gates the
 *     Continue button (a continuation IS a prefill of the existing text).
 *   - `resolvePerSendPrefillSupport` is the LOCAL-only strip gate (owner
 *     2026-09-09: no cloud prefill surfacing): local preset ids pass (except
 *     koboldcpp — no prefill channel), clouds fail closed, and the generic
 *     `openai_compat` preset id is resolved by ENDPOINT (localhost → local,
 *     remote host → cloud).
 */
import { describe, expect, it } from "bun:test";
import {
  resolveAssistantPrefillSupport,
  resolvePerSendPrefillSupport,
} from "../src/provider-support.js";

describe("resolveAssistantPrefillSupport", () => {
  it("denies the no-prefill-channel presets (mirrors the protocol registry)", () => {
    for (const preset of ["anthropic", "google", "google_interactions", "koboldcpp"]) {
      const result = resolveAssistantPrefillSupport(preset);
      expect(result.supported).toBe(false);
    }
  });

  it("supports the prefill-capable protocols and their preset ids", () => {
    for (const preset of ["llamacpp", "ollama", "unsloth", "lmstudio", "vllm", "ooba", "tabby", "aphrodite", "openai_compat", "openai", "openrouter", "nanogpt"]) {
      expect(resolveAssistantPrefillSupport(preset).supported).toBe(true);
    }
  });

  it("treats absent/unknown presets as supported (registry default: prefill-capable family)", () => {
    expect(resolveAssistantPrefillSupport(null).supported).toBe(true);
    expect(resolveAssistantPrefillSupport(undefined).supported).toBe(true);
    expect(resolveAssistantPrefillSupport("").supported).toBe(true);
  });
});

describe("resolvePerSendPrefillSupport (strip — local only)", () => {
  it("supports local backends with a prefill channel", () => {
    for (const preset of ["llamacpp", "ollama", "unsloth", "lmstudio", "vllm", "ooba", "tabby", "aphrodite"]) {
      expect(resolvePerSendPrefillSupport(preset).supported).toBe(true);
    }
  });

  it("resolves the generic openai_compat preset id by endpoint", () => {
    expect(resolvePerSendPrefillSupport("openai_compat", "http://localhost:1234/v1").supported).toBe(true);
    expect(resolvePerSendPrefillSupport("openai_compat", "http://127.0.0.1:8080").supported).toBe(true);
    expect(resolvePerSendPrefillSupport("openai_compat", "https://openrouter.ai/api/v1").supported).toBe(false);
    expect(resolvePerSendPrefillSupport("openai_compat").supported).toBe(false);
  });

  it("denies koboldcpp (no prefill channel) even though it is local", () => {
    const result = resolvePerSendPrefillSupport("koboldcpp");
    expect(result.supported).toBe(false);
    expect(result.reason).toBe("provider_has_no_prefill_channel");
  });

  it("denies clouds and unknown presets (fail closed)", () => {
    expect(resolvePerSendPrefillSupport("openai").supported).toBe(false);
    expect(resolvePerSendPrefillSupport("openrouter", "https://openrouter.ai/api/v1").supported).toBe(false);
    expect(resolvePerSendPrefillSupport("anthropic").supported).toBe(false);
    expect(resolvePerSendPrefillSupport("some-unknown-id").supported).toBe(false);
    expect(resolvePerSendPrefillSupport(null).supported).toBe(false);
  });
});
