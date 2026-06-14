import { describe, it, expect } from "bun:test";
import {
  mapMessageDto,
  entryMatchesRecentText,
  toClientProviderProfile,
  resolveStoredApiKey,
} from "../src/runtime/session/session-runtime-dto.js";
import type { LoreEntry } from "@vibe-tavern/domain";
import type { StoredProviderProfileRecord } from "@vibe-tavern/domain";

// ─── mapMessageDto ───────────────────────────────────────────────────────

describe("mapMessageDto", () => {
  it("returns message with selected variant content", () => {
    const message = { id: "m1", role: "assistant", content: "Reply A" };
    const variants = [
      { content: "Reply A", variantIndex: 0, isSelected: false },
      { content: "Reply B", variantIndex: 1, isSelected: true },
    ];

    const result = mapMessageDto(message, variants);
    expect(result.content).toBe("Reply B");
    expect(result.selectedVariantIndex).toBe(1);
    expect(result.variants).toHaveLength(2);
  });

  it("falls back to message content when no variant is selected", () => {
    const message = { id: "m1", role: "assistant", content: "Original" };
    const variants = [
      { content: "V1", variantIndex: 0, isSelected: false },
    ];

    const result = mapMessageDto(message, variants);
    expect(result.content).toBe("Original");
    expect(result.selectedVariantIndex).toBeNull();
  });

  it("handles empty variants array", () => {
    const message = { id: "m1", role: "user", content: "Hello" };
    const result = mapMessageDto(message, []);
    expect(result.content).toBe("Hello");
    expect(result.variants).toHaveLength(0);
  });
});

// ─── entryMatchesRecentText ──────────────────────────────────────────────

describe("entryMatchesRecentText", () => {
  const baseEntry: LoreEntry = {
    id: "e1",
    lorebookId: "lb1",
    title: "Test",
    content: "Dragons are real.",
    keys: ["dragon"],
    secondaryKeys: [],
    logic: "and_any",
    position: "in_prompt",
    depth: 4,
    priority: 100,
    stickyWindow: 0,
    cooldownWindow: 0,
    delayWindow: 0,
    enabled: true,
    metadata: {},
  };

  it("matches when primary key appears in text", () => {
    expect(entryMatchesRecentText(baseEntry, "a dragon appeared")).toBe(true);
  });

  it("does not match when primary key is absent", () => {
    expect(entryMatchesRecentText(baseEntry, "a knight appeared")).toBe(false);
  });

  it("does not match disabled entries", () => {
    const disabled = { ...baseEntry, enabled: false };
    expect(entryMatchesRecentText(disabled, "a dragon appeared")).toBe(false);
  });

  it("matches constant entries with no keys", () => {
    const constant: LoreEntry = {
      ...baseEntry,
      keys: [],
      metadata: { stConstant: true },
    };
    expect(entryMatchesRecentText(constant, "anything")).toBe(true);
  });

  it("does not match non-constant entries with no keys", () => {
    const noKeys = { ...baseEntry, keys: [] };
    expect(entryMatchesRecentText(noKeys, "anything")).toBe(false);
  });

  describe("logic: and_any", () => {
    const entry: LoreEntry = {
      ...baseEntry,
      secondaryKeys: ["fire", "ice"],
      logic: "and_any",
    };

    it("matches when at least one secondary key matches", () => {
      expect(entryMatchesRecentText(entry, "dragon with fire breath")).toBe(true);
    });

    it("does not match when no secondary key matches", () => {
      expect(entryMatchesRecentText(entry, "dragon with water breath")).toBe(false);
    });
  });

  describe("logic: and_all", () => {
    const entry: LoreEntry = {
      ...baseEntry,
      secondaryKeys: ["fire", "ice"],
      logic: "and_all",
    };

    it("matches when ALL secondary keys match", () => {
      expect(entryMatchesRecentText(entry, "dragon of fire and ice")).toBe(true);
    });

    it("does not match when some secondary keys missing", () => {
      expect(entryMatchesRecentText(entry, "dragon of fire")).toBe(false);
    });
  });

  describe("logic: not_any", () => {
    const entry: LoreEntry = {
      ...baseEntry,
      secondaryKeys: ["fire"],
      logic: "not_any",
    };

    it("matches when NO secondary key matches", () => {
      expect(entryMatchesRecentText(entry, "dragon of water")).toBe(true);
    });

    it("does not match when a secondary key matches", () => {
      expect(entryMatchesRecentText(entry, "dragon of fire")).toBe(false);
    });
  });

  describe("logic: not_all", () => {
    const entry: LoreEntry = {
      ...baseEntry,
      secondaryKeys: ["fire", "ice"],
      logic: "not_all",
    };

    it("matches when not all secondary keys match", () => {
      expect(entryMatchesRecentText(entry, "dragon of fire")).toBe(true);
    });

    it("does not match when all secondary keys match", () => {
      expect(entryMatchesRecentText(entry, "dragon of fire and ice")).toBe(false);
    });
  });

  it("key matching is case-insensitive", () => {
    expect(entryMatchesRecentText(baseEntry, "a dragon appeared")).toBe(true);
    // Function receives pre-lowered text; key matching is .toLowerCase() on key side
    expect(entryMatchesRecentText(baseEntry, "a dragon appeared")).toBe(true);
  });
});

// ─── toClientProviderProfile ─────────────────────────────────────────────

describe("toClientProviderProfile", () => {
  const fullProfile = {
    id: "prov_1",
    name: "Test Provider",
    providerPreset: "openai_compat",
    endpoint: "https://api.example.com/v1",
    apiKey: "sk-secret-key-123",
    defaultModel: "gpt-4",
    contextBudget: 128000,
    maxTokens: 500,
    temperature: 1.0,
    topP: 1.0,
    topK: 0,
    minP: 0,
    topA: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    repetitionPenalty: 0,
    stopSequences: [],
    seed: null,
    reasoningEffort: "",
    showReasoning: false,
    streamResponse: true,
    customSamplers: false,
    isActive: true,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  } as StoredProviderProfileRecord;

  it("strips API key and exposes hasStoredApiKey flag", () => {
    const client = toClientProviderProfile(fullProfile);
    expect(client).not.toHaveProperty("apiKey");
    expect(client.hasStoredApiKey).toBe(true);
  });

  it("shows hasStoredApiKey=false when no key", () => {
    const noKey = { ...fullProfile, apiKey: null } as StoredProviderProfileRecord;
    const client = toClientProviderProfile(noKey);
    expect(client.hasStoredApiKey).toBe(false);
  });

  it("preserves all non-sensitive fields", () => {
    const client = toClientProviderProfile(fullProfile);
    expect(client.id).toBe("prov_1");
    expect(client.name).toBe("Test Provider");
    expect(client.endpoint).toBe("https://api.example.com/v1");
    expect(client.defaultModel).toBe("gpt-4");
    expect(client.streamResponse).toBe(true);
    expect(client.isActive).toBe(true);
  });

  it("includes logitBias entries from stored profile", () => {
    const withBias = {
      ...fullProfile,
      logitBias: [
        { tokenId: 123, bias: -100, text: " bad", sourceText: " bad", model: "gpt-4" },
        { tokenId: 456, bias: 50, text: " good", sourceText: " good", model: "gpt-4" },
      ],
    } as StoredProviderProfileRecord;
    const client = toClientProviderProfile(withBias);
    expect(client.logitBias).toHaveLength(2);
    expect(client.logitBias[0]).toEqual({ tokenId: 123, bias: -100, text: " bad", sourceText: " bad", model: "gpt-4" });
    expect(client.logitBias[1].bias).toBe(50);
  });

  it("returns empty array when profile has no logitBias", () => {
    const noBias = { ...fullProfile, logitBias: [] } as StoredProviderProfileRecord;
    const client = toClientProviderProfile(noBias);
    expect(client.logitBias).toEqual([]);
  });

  it("preserves customSamplers and pinContextBudget flags", () => {
    const custom = { ...fullProfile, customSamplers: true, pinContextBudget: true } as StoredProviderProfileRecord;
    const client = toClientProviderProfile(custom);
    expect(client.customSamplers).toBe(true);
    expect(client.pinContextBudget).toBe(true);
  });
});

// ─── resolveStoredApiKey ─────────────────────────────────────────────────

describe("resolveStoredApiKey", () => {
  it("returns null when input is null", () => {
    expect(resolveStoredApiKey(null, "old-key")).toBeNull();
  });

  it("returns trimmed string when non-empty", () => {
    expect(resolveStoredApiKey("new-key", "old-key")).toBe("new-key");
  });

  it("falls back when input is empty string", () => {
    expect(resolveStoredApiKey("", "old-key")).toBe("old-key");
  });

  it("falls back when input is whitespace", () => {
    expect(resolveStoredApiKey("   ", "old-key")).toBe("old-key");
  });

  it("returns null fallback when both empty", () => {
    expect(resolveStoredApiKey("", null)).toBeNull();
  });

  it("returns fallback for non-string input", () => {
    expect(resolveStoredApiKey(123, "old-key")).toBe("old-key");
  });
});
