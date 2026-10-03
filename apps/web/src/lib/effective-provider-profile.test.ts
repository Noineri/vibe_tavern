/**
 * RP_QUICK_SWITCH_MODEL_SETTINGS_REPORT step 2 — the chat-side read of the
 * ACTIVE model's effective settings.
 *
 * resolveActiveModelEffectiveProfile is the single web-side derivation the RP
 * chat UI reads (token-counter budget + max output in useInputArea — consumed
 * by the desktop and mobile branches alike — and the context-memory window
 * meter in AppShell). It must mirror the backend's overlay policy
 * (chat-adapter resolveEffectiveProfileOrThrow) and merge through the SAME
 * domain function the generation boundary calls (resolveEffectiveSettings) —
 * the pins below lock both the policy and the merge contract:
 *  - binding OFF → the base record itself (identical reference), even when an
 *    overlay row for the model exists;
 *  - binding ON + overlay row for the active model → overlay fields win,
 *    absent overlay fields inherit the base ("absent = inherit", the
 *    resolveEffectiveSettings contract);
 *  - binding ON + no overlay row for the active model (non-favorite or simply
 *    unsaved) → the base record itself.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderProfileRecord } from "../api/types.js";
import { resolveActiveModelEffectiveProfile, type ModelSettingsOverlayRow } from "./effective-provider-profile.js";

function makeProfile(over: Partial<ProviderProfileRecord> = {}): ProviderProfileRecord {
  return {
    id: "p1",
    name: "Profile",
    providerPreset: "openaiCompat",
    coauthorTransport: "chatCompletions",
    generationMode: "chat",
    endpoint: "http://localhost:1234/v1",
    defaultModel: "m-base",
    visionModel: null,
    contextBudget: 16000,
    pinContextBudget: false,
    tokenPadding: 512,
    bindPerModel: true,
    modelFreeOnly: false,
    modelGroupByOwner: false,
    maxTokens: 2000,
    temperature: 0.8,
    topP: 0.95, minP: 0.05, topK: 40, topA: 0, typicalP: 1, tfsZ: 1,
    adaptiveTarget: -1, adaptiveDecay: 0.9, dynatempRange: 0, dynatempExponent: 1,
    topNSigma: 0, smoothingFactor: 0, repeatLastN: 0,
    mirostat: 0, mirostatTau: 5, mirostatEta: 0.1,
    dryMultiplier: 0, dryBase: 1.75, dryAllowedLength: 2, dryPenaltyLastN: -1, drySequenceBreakers: [],
    xtcThreshold: 0.1, xtcProbability: 0,
    frequencyPenalty: 0, presencePenalty: 0, repetitionPenalty: 1,
    stopSequences: [], bannedStrings: [], logitBias: [],
    seed: null, reasoningEffort: "auto", showReasoning: false, streamResponse: true,
    customSamplers: false, proxyMode: "inherit", proxyId: null,
    isActive: true, samplerSetId: null, generationFormat: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    hasStoredApiKey: true,
    ...over,
  } as ProviderProfileRecord;
}

function makeRow(modelId: string, settings: ModelSettingsOverlayRow["settings"]): ModelSettingsOverlayRow {
  return { modelId, settings };
}

describe("resolveActiveModelEffectiveProfile", () => {
  test("binding ON + overlay for the active model → overlay budget/maxTokens win", () => {
    const base = makeProfile();
    const rows = [makeRow("m-fav", { contextBudget: 131072, maxTokens: 8192 })];
    const effective = resolveActiveModelEffectiveProfile(base, "m-fav", rows);
    expect(effective.contextBudget).toBe(131072);
    expect(effective.maxTokens).toBe(8192);
  });

  test("tokenPadding (profile-level, not an overlay field) inherits the base", () => {
    const base = makeProfile();
    const rows = [makeRow("m-fav", { contextBudget: 131072 })];
    const effective = resolveActiveModelEffectiveProfile(base, "m-fav", rows);
    expect(effective.tokenPadding).toBe(512);
  });

  test("absent overlay fields inherit the base (absent = inherit contract)", () => {
    const base = makeProfile({ maxTokens: 4096 });
    const rows = [makeRow("m-fav", { maxTokens: 8192 })]; // no contextBudget on the overlay
    const effective = resolveActiveModelEffectiveProfile(base, "m-fav", rows);
    expect(effective.maxTokens).toBe(8192);
    expect(effective.contextBudget).toBe(16000); // base value, not overwritten
  });

  test("binding ON + no overlay row for the active model → the base record itself", () => {
    const base = makeProfile();
    const rows = [makeRow("m-other", { contextBudget: 131072, maxTokens: 8192 })];
    const effective = resolveActiveModelEffectiveProfile(base, "m-fav", rows);
    expect(effective).toBe(base);
    expect(effective.contextBudget).toBe(16000);
  });

  test("binding ON + rows not loaded yet (undefined) → the base record itself", () => {
    const base = makeProfile();
    expect(resolveActiveModelEffectiveProfile(base, "m-base", undefined)).toBe(base);
  });

  test("binding OFF → the base record itself even when an overlay row exists", () => {
    const base = makeProfile({ bindPerModel: false, defaultModel: "m-fav" });
    const rows = [makeRow("m-fav", { contextBudget: 131072, maxTokens: 8192 })];
    const effective = resolveActiveModelEffectiveProfile(base, "m-fav", rows);
    expect(effective).toBe(base);
    expect(effective.contextBudget).toBe(16000);
    expect(effective.maxTokens).toBe(2000);
  });

  test("no active model → the base record itself", () => {
    const base = makeProfile();
    const rows = [makeRow("m-fav", { contextBudget: 131072 })];
    expect(resolveActiveModelEffectiveProfile(base, null, rows)).toBe(base);
  });

  test("merged record keeps the wire shape: no apiKey, hasStoredApiKey survives", () => {
    const base = makeProfile();
    const rows = [makeRow("m-fav", { contextBudget: 131072 })];
    const effective = resolveActiveModelEffectiveProfile(base, "m-fav", rows);
    expect("apiKey" in effective).toBe(false);
    expect(effective.hasStoredApiKey).toBe(true);
    expect(effective.id).toBe("p1");
  });
});
