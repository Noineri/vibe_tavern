import { describe, expect, test } from "bun:test";
import { createDb, ServicePromptProfileStore, UiSettingsStore } from "@vibe-tavern/db";
import { trackerTemplateSchema } from "@vibe-tavern/api-contracts";
import type { ProviderExecutionInput } from "../src/infrastructure/ai/provider-execution-types.js";
import {
  createTrackerDelegate,
  type TrackerDelegateInput,
  type TrackerExecutor,
} from "../src/domain/coauthor/tracker/tracker-delegate.js";

const fakeProfile = { id: "prof_1", name: "p", providerType: "openai" } as ProviderExecutionInput["profile"];

const validTemplate = trackerTemplateSchema.parse({
  version: 1,
  scene: { enabled: true, config: { schema: { location: { $type: "string" } }, generatePrompt: "Track location." } },
  objective: null,
});

async function setupDb() {
  const db = await createDb(":memory:");
  const profileStore = new ServicePromptProfileStore(db);
  const uiSettings = new UiSettingsStore(db);
  await profileStore.ensureDefaultServicePromptProfile();
  return { db, profileStore, uiSettings };
}

function sampleInput(overrides: Partial<TrackerDelegateInput> = {}): TrackerDelegateInput {
  return {
    action: "refine",
    modeHint: "goals",
    focusNotes: "Keep the tracker focused on the chase.",
    characterProfileMd: "# PERSONALITY\nVex is a commander.",
    currentTemplate: validTemplate,
    ...overrides,
  };
}

function messagesOf(prompt: ProviderExecutionInput["prompt"]): Array<{ role: string; content: string }> {
  return (prompt.finalPayload as { messages?: Array<{ role: string; content: string }> }).messages ?? [];
}

describe("createTrackerDelegate (CT-11)", () => {
  test("uses the tracker teaching asset, grounds the live profile and refine base, and returns a validated template", async () => {
    const { db } = await setupDb();
    let captured: ProviderExecutionInput | null = null;
    const execute: TrackerExecutor = async (input) => {
      captured = input;
      return { text: JSON.stringify(validTemplate) };
    };

    const result = await createTrackerDelegate({ execute, profile: fakeProfile, model: "small-model", db })(sampleInput());

    expect(result.trackerTemplate).toEqual(validTemplate);
    const messages = messagesOf(captured!.prompt);
    expect(messages[0]!.content).toContain("UNION RULE");
    expect(messages[0]!.content).toContain("Grounding (co-author delegation)");
    expect(messages[0]!.content).toContain("Vex is a commander.");
    expect(messages[0]!.content).toContain("Refine base (current tracker template):");
    expect(messages[0]!.content).toContain(JSON.stringify(validTemplate, null, 2));
    expect(messages[1]!.content).toContain("Action: refine.");
    expect(messages[1]!.content).toContain("Mode hint: goals.");
    expect(messages[1]!.content).toContain("Keep the tracker focused on the chase.");
    expect(captured!.model).toBe("small-model");
  });

  test("honors the active tracker-template service-prompt override and omits a missing refine base", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    const profile = await profileStore.createServicePromptProfile({
      name: "Tracker override",
      overrides: { tracker_template: "CUSTOM TRACKER ASSET" },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });
    let captured: ProviderExecutionInput | null = null;
    const execute: TrackerExecutor = async (input) => {
      captured = input;
      return { text: JSON.stringify(validTemplate) };
    };

    await createTrackerDelegate({ execute, profile: fakeProfile, model: "m", db })(sampleInput({ currentTemplate: null }));

    expect(messagesOf(captured!.prompt)[0]!.content).toContain("CUSTOM TRACKER ASSET");
    expect(messagesOf(captured!.prompt)[0]!.content).not.toContain("Refine base (current tracker template):");
  });

  test("retries once with parse errors and accepts a valid repair", async () => {
    const { db } = await setupDb();
    const calls: ProviderExecutionInput[] = [];
    const execute: TrackerExecutor = async (input) => {
      calls.push(input);
      return { text: calls.length === 1 ? "{not json" : JSON.stringify(validTemplate) };
    };

    const result = await createTrackerDelegate({ execute, profile: fakeProfile, model: "m", db })(sampleInput({ action: "create", currentTemplate: null }));

    expect(result.trackerTemplate).toEqual(validTemplate);
    expect(calls).toHaveLength(2);
    expect(messagesOf(calls[1]!.prompt)[1]!.content).toContain("previous response was rejected");
    expect(messagesOf(calls[1]!.prompt)[1]!.content).toContain("malformed JSON");
  });

  test("rejects after the one bounded repair round when both outputs fail validation", async () => {
    const { db } = await setupDb();
    let calls = 0;
    const execute: TrackerExecutor = async () => {
      calls += 1;
      return { text: JSON.stringify({ version: 1, scene: null, objective: null }) };
    };

    await expect(createTrackerDelegate({ execute, profile: fakeProfile, model: "m", db })(sampleInput())).rejects.toThrow(/failed validation/);
    expect(calls).toBe(2);
  });

  test("forwards the abort signal to both the initial call and its repair", async () => {
    const { db } = await setupDb();
    const signals: Array<AbortSignal | undefined> = [];
    let calls = 0;
    const execute: TrackerExecutor = async (input) => {
      signals.push(input.signal);
      calls += 1;
      return { text: calls === 1 ? "not json" : JSON.stringify(validTemplate) };
    };
    const controller = new AbortController();

    await createTrackerDelegate({ execute, profile: fakeProfile, model: "m", db })(sampleInput(), controller.signal);

    expect(signals).toEqual([controller.signal, controller.signal]);
  });
});
