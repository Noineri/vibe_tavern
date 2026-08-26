import { describe, test, expect } from "bun:test";
import { createDb } from "@vibe-tavern/db";
import { ServicePromptProfileStore } from "@vibe-tavern/db";
import { UiSettingsStore } from "@vibe-tavern/db";
import type { StoreClock, StoreIdGenerator } from "@vibe-tavern/db";
import { resolveInsightsPromptWithProfile } from "../src/domain/insights/insights-prompts.js";
import { resolveServicePromptText } from "../src/domain/service-prompts/service-prompt-resolver.js";
import { assembleCoauthorPrompt } from "../src/domain/chat/coauthor-prompt.js";
import type { ChatModeAssembleInput } from "../src/domain/chat/chat-mode-strategy.js";
import { resolveBuiltinCopilotProfile } from "../src/domain/interactive/copilot/experience-copilot-module.js";
import { assembleExperienceCopilotPrompt } from "../src/domain/interactive/copilot/experience-copilot-prompt.js";
import { loadPromptAsset } from "../src/shared/prompt-asset-loader.js";

const fixedClock: StoreClock = { now: () => "2026-08-26T00:00:00.000Z" };
let counter = 0;
const idGen: StoreIdGenerator = { next: (prefix) => `${prefix}_test_${++counter}` };

async function setupDb() {
  counter = 0;
  const db = await createDb(":memory:");
  const profileStore = new ServicePromptProfileStore(db, { clock: fixedClock, idGenerator: idGen });
  const uiSettings = new UiSettingsStore(db, { clock: fixedClock, idGenerator: idGen });
  await profileStore.ensureDefaultServicePromptProfile();
  return { db, profileStore, uiSettings };
}

describe("SP-5 insights: per-chat -> profile -> asset", () => {
  test("per-chat insight override beats profile", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    const profile = await profileStore.createServicePromptProfile({
      name: "WithProfile",
      overrides: { objective_generate: "PROFILE-OVERRIDE" },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });

    const result = await resolveInsightsPromptWithProfile(db, "objectiveGenerate", "PER-CHAT-OVERRIDE");
    expect(result).toBe("PER-CHAT-OVERRIDE");
  });

  test("profile override beats asset for insights", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    const profile = await profileStore.createServicePromptProfile({
      name: "WithProfile",
      overrides: { objective_generate: "PROFILE-OVERRIDE" },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });

    const result = await resolveInsightsPromptWithProfile(db, "objectiveGenerate", "");
    expect(result).toBe("PROFILE-OVERRIDE");

    // Also whitespace per-chat falls through to profile
    const white = await resolveInsightsPromptWithProfile(db, "objectiveGenerate", "   ");
    expect(white).toBe("PROFILE-OVERRIDE");

    // Without profile, falls through to asset (contains known phrase from asset)
    const { db: db2 } = await setupDb();
    const assetResult = await resolveInsightsPromptWithProfile(db2, "objectiveGenerate", "");
    const directAsset = await loadPromptAsset("objective-generate.md");
    expect(assetResult).toBe(directAsset.trim());
  });

  test("profile whitespace falls through to asset", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    const profile = await profileStore.createServicePromptProfile({
      name: "Whitespace",
      overrides: { objective_check: "   " },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });
    const result = await resolveInsightsPromptWithProfile(db, "objectiveCheck", "");
    const asset = await loadPromptAsset("objective-check.md");
    expect(result).toBe(asset.trim());
  });
});

describe("SP-5 coauthor base honors profile", () => {
  test("coauthor base uses active profile override when db present", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    const profile = await profileStore.createServicePromptProfile({
      name: "CoauthorOverride",
      overrides: { coauthor_base: "COAUTHOR-PROFILE-PROMPT" },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });

    const loaders = {
      getChat: async () => ({ id: "chat_test", coauthorModuleId: null }) as never,
      getMessages: async () => [] as never,
      getCharacter: async () => ({
        id: "char_test",
        name: "Test",
        description: "desc",
        personalitySummary: null,
        defaultScenario: null,
        firstMessage: "hi",
        alternateGreetings: [],
        postHistoryInstructions: null,
        creatorNotes: null,
        characterBook: null,
        depthPrompt: null,
        depthPromptDepth: null,
        depthPromptRole: null,
        extensions: {},
        systemPrompt: null,
        tags: [],
        avatarAssetId: null,
        avatarFullAssetId: null,
        avatarCrop: null,
        avatarExt: null,
        hasFileOnDisk: true,
      } as never),
      getProfileMdText: async () => "# PERSONALITY\nTest\n",
      getCoauthorContextItems: async () => [],
      getCoauthorBoundResources: async () => ({ lorebooks: [], scripts: [] }),
      getChatSummaries: async () => [],
      getCoauthorUserModules: async () => [],
      getSkillCatalog: async () => [],
    } as unknown as ChatModeAssembleInput["loaders"];

    const input = {
      chatId: "chat_test" as never,
      model: "test-model",
      promptService: {} as never,
      loaders,
      db: db,
    } as ChatModeAssembleInput;

    const result = await assembleCoauthorPrompt(input);
    const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;
    expect(system).toContain("COAUTHOR-PROFILE-PROMPT");
    expect(system).not.toContain("Co-Author base (editor contract)"); // asset marker when default? Actually asset starts with something else; ensure override wins
  });

  test("coauthor base falls back to asset when no profile override", async () => {
    const { db } = await setupDb();
    const loaders = {
      getChat: async () => ({ id: "chat_test", coauthorModuleId: null }) as never,
      getMessages: async () => [] as never,
      getCharacter: async () => ({
        id: "char_test",
        name: "Test",
        description: "desc",
        personalitySummary: null,
        defaultScenario: null,
        firstMessage: "hi",
        alternateGreetings: [],
        postHistoryInstructions: null,
        creatorNotes: null,
        characterBook: null,
        depthPrompt: null,
        depthPromptDepth: null,
        depthPromptRole: null,
        extensions: {},
        systemPrompt: null,
        tags: [],
        avatarAssetId: null,
        avatarFullAssetId: null,
        avatarCrop: null,
        avatarExt: null,
        hasFileOnDisk: true,
      } as never),
      getProfileMdText: async () => "# PERSONALITY\nTest\n",
      getCoauthorContextItems: async () => [],
      getCoauthorBoundResources: async () => ({ lorebooks: [], scripts: [] }),
      getChatSummaries: async () => [],
      getCoauthorUserModules: async () => [],
      getSkillCatalog: async () => [],
    } as unknown as ChatModeAssembleInput["loaders"];
    const input = {
      chatId: "chat_test" as never,
      model: "test-model",
      promptService: {} as never,
      loaders,
      db: db,
    } as ChatModeAssembleInput;
    const result = await assembleCoauthorPrompt(input);
    const system = (result.prompt.finalPayload as { messages: Array<{ content: string }> }).messages[0].content;
    const asset = await loadPromptAsset("coauthor/base.md");
    expect(system).toContain(asset.slice(0, 20));
  });
});

describe("SP-5 copilot base honors profile only for builtin", () => {
  test("builtin copilot base honors profile override", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    const profile = await profileStore.createServicePromptProfile({
      name: "CopilotOverride",
      overrides: { copilot_base: "COPILOT-PROFILE-BASE" },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });

    const builtin = await resolveBuiltinCopilotProfile(db);
    expect(builtin.basePrompt).toBe("COPILOT-PROFILE-BASE");
    expect(builtin.isBuiltIn).toBe(true);
  });

  test("explicit copilot profile basePrompt does NOT consult global override", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    const globalProfile = await profileStore.createServicePromptProfile({
      name: "GlobalCopilot",
      overrides: { copilot_base: "GLOBAL-COPILOT-BASE" },
    });
    await uiSettings.update({ activeServicePromptProfileId: globalProfile.id });

    const explicitProfile = {
      id: "explicit",
      name: "Explicit",
      isBuiltIn: false,
      basePrompt: "EXPLICIT-BASE",
      skillIds: ["experience-authoring"],
      toolSet: { write_buffer: true },
    } as never;

    const result = await assembleExperienceCopilotPrompt({
      history: [],
      rules: "",
      step: "rules",
      profile: explicitProfile,
      db: db,
    });
    expect(result.systemMessage).toContain("EXPLICIT-BASE");
    expect(result.systemMessage).not.toContain("GLOBAL-COPILOT-BASE");
  });

  test("copilot reference prompts honor profile when db present", async () => {
    const { db, profileStore, uiSettings } = await setupDb();
    const profile = await profileStore.createServicePromptProfile({
      name: "Refs",
      overrides: {
        interactive_rules: "RULES-OVERRIDE",
        interactive_visual: "VISUAL-OVERRIDE",
        copilot_user_flow: "USERFLOW-OVERRIDE",
      },
    });
    await uiSettings.update({ activeServicePromptProfileId: profile.id });

    const result = await assembleExperienceCopilotPrompt({
      history: [],
      rules: "some rules",
      step: "rules",
      db: db,
    });
    expect(result.systemMessage).toContain("RULES-OVERRIDE");
    expect(result.systemMessage).toContain("VISUAL-OVERRIDE");
    expect(result.systemMessage).toContain("USERFLOW-OVERRIDE");
  });
});
