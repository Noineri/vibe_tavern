import { describe, expect, test } from "bun:test";
import {
  applyTrackerTemplate,
  computeSceneSchemaHash,
  defaultObjectiveState,
  normalizeInsightsConfig,
  normalizeObjectiveState,
  normalizeTrackerTemplate,
  readTrackerTemplate,
  trackerTemplateFromChat,
  withTrackerTemplate,
} from "../src/index.js";

describe("tracker templates", () => {
  test("round trips chat template fields while omitting and resetting machine-local picks", () => {
    const sourceInsights = normalizeInsightsConfig({
      trackerEnabled: true,
      diceEnabled: true,
      diceMode: "immersive",
      diceScriptIds: ["dice_1"],
      diceActorBindings: { dice_1: ["persona"] },
      tracker: {
        schema: { mood: { $type: "string" } },
        autoMode: "manual",
        contextWindow: 8,
        continuityLastN: 2,
        injectionDepth: 3,
        injectLastN: 2,
        promptFormat: "xml",
        generatePrompt: "Generate the scene",
        injectPrompt: "Inject the scene",
        rulesPrompt: "Keep it concise",
        useChatModel: false,
        providerProfileId: "scene_profile",
        model: "scene_model",
        revision: 7,
      },
    });
    const sourceObjective = normalizeObjectiveState({
      mode: "goals",
      objectiveDescription: "Reach the tower",
      shortTermGoals: [{ id: "goal_1", description: "Find the road", status: "pending" }],
      longTermGoal: { description: "Defeat the wizard", status: "pending" },
      autoCheckFrequency: 3,
      autoCheckEventCount: 5,
      contextWindow: 9,
      injectionDepth: 2,
      generatePrompt: "Generate goals",
      checkPrompt: "Check goals",
      injectPrompt: "Inject goals",
      useChatModel: false,
      providerProfileId: "objective_profile",
      model: "objective_model",
    });
    const template = trackerTemplateFromChat(sourceInsights, sourceObjective);

    expect(template).not.toBeNull();
    expect(template?.scene?.config).not.toHaveProperty("useChatModel");
    expect(template?.scene?.config).not.toHaveProperty("providerProfileId");
    expect(template?.scene?.config).not.toHaveProperty("model");
    expect(template?.scene?.config).not.toHaveProperty("revision");
    expect(template?.scene?.config).not.toHaveProperty("schemaHash");
    expect(template?.objective?.state).not.toHaveProperty("useChatModel");
    expect(template?.objective?.state).not.toHaveProperty("providerProfileId");
    expect(template?.objective?.state).not.toHaveProperty("model");
    expect(template?.objective?.state).not.toHaveProperty("autoCheckEventCount");

    const applied = applyTrackerTemplate(template!, {
      insightsConfig: normalizeInsightsConfig({}),
      objectiveState: defaultObjectiveState(),
    });

    expect(applied.insightsConfig).toMatchObject({
      trackerEnabled: true,
      diceEnabled: false,
      diceMode: "normal",
      diceScriptIds: null,
      diceActorBindings: null,
    });
    expect(applied.insightsConfig.tracker).toMatchObject({
      schema: sourceInsights.tracker?.schema,
      autoMode: "manual",
      contextWindow: 8,
      continuityLastN: 2,
      injectionDepth: 3,
      injectLastN: 2,
      promptFormat: "xml",
      generatePrompt: "Generate the scene",
      injectPrompt: "Inject the scene",
      rulesPrompt: "Keep it concise",
      useChatModel: true,
      providerProfileId: null,
      model: null,
      revision: 1,
      schemaHash: computeSceneSchemaHash(sourceInsights.tracker?.schema ?? {}),
    });
    expect(applied.objectiveState).toMatchObject({
      mode: "goals",
      objectiveDescription: "Reach the tower",
      shortTermGoals: [{ id: "goal_1", description: "Find the road", status: "pending" }],
      longTermGoal: { description: "Defeat the wizard", status: "pending" },
      autoCheckFrequency: 3,
      contextWindow: 9,
      injectionDepth: 2,
      generatePrompt: "Generate goals",
      checkPrompt: "Check goals",
      injectPrompt: "Inject goals",
      useChatModel: true,
      providerProfileId: null,
      model: null,
      autoCheckEventCount: 0,
    });
    expect(trackerTemplateFromChat(applied.insightsConfig, applied.objectiveState)).toEqual(template);
  });

  test("normalization and chat extraction reset every objective status to pending", () => {
    const template = normalizeTrackerTemplate({
      version: 1,
      objective: {
        enabled: true,
        state: {
          tasks: [{ id: "task_1", description: "Complete it", status: "active" }],
          shortTermGoals: [{ id: "goal_1", description: "Start it", status: "completed" }],
          longTermGoal: { description: "Finish it", status: "abandoned" },
        },
      },
    });

    expect(template?.objective?.state.tasks[0]?.status).toBe("pending");
    expect(template?.objective?.state.shortTermGoals[0]?.status).toBe("pending");
    expect(template?.objective?.state.longTermGoal?.status).toBe("pending");

    const fromChat = trackerTemplateFromChat(
      normalizeInsightsConfig({ objectiveEnabled: true }),
      normalizeObjectiveState({ tasks: [{ id: "task_1", description: "Complete it", status: "active" }] }),
    );
    expect(fromChat?.objective?.state.tasks[0]?.status).toBe("pending");
  });

  test("apply preserves dice fields and leaves absent template parts unchanged", () => {
    const current = {
      insightsConfig: normalizeInsightsConfig({
        objectiveEnabled: true,
        trackerEnabled: true,
        diceEnabled: true,
        diceMode: "immersive",
        diceScriptIds: ["dice_1"],
        diceActorBindings: { dice_1: ["character"] },
        tracker: { schema: { location: { $type: "string" } }, revision: 4 },
      }),
      objectiveState: normalizeObjectiveState({ objectiveDescription: "Existing objective" }),
    };
    const sceneOnly = normalizeTrackerTemplate({
      version: 1,
      scene: { enabled: false, config: { schema: { mood: { $type: "string" } } } },
    });
    const objectiveOnly = normalizeTrackerTemplate({
      version: 1,
      objective: { enabled: false, state: { objectiveDescription: "Replacement objective" } },
    });

    const afterScene = applyTrackerTemplate(sceneOnly!, current);
    expect(afterScene.insightsConfig).toMatchObject({
      diceEnabled: true,
      diceMode: "immersive",
      diceScriptIds: ["dice_1"],
      diceActorBindings: { dice_1: ["character"] },
    });
    expect(afterScene.objectiveState).toBe(current.objectiveState);

    const afterObjective = applyTrackerTemplate(objectiveOnly!, current);
    expect(afterObjective.insightsConfig.tracker).toBe(current.insightsConfig.tracker);
    expect(afterObjective.insightsConfig).toMatchObject({
      diceEnabled: true,
      diceMode: "immersive",
      diceScriptIds: ["dice_1"],
      diceActorBindings: { dice_1: ["character"] },
    });
  });

  test("stores templates without disturbing foreign or sibling extension values", () => {
    const template = normalizeTrackerTemplate({
      version: 1,
      scene: { enabled: true, config: { schema: { mood: { $type: "string" } } } },
    });
    const extensions = {
      depth_prompt: { depth: 4, prompt: "Foreign extension" },
      vibe_tavern: { other: { retained: true } },
    };
    const stored = withTrackerTemplate(extensions, template);

    expect(stored).not.toBe(extensions);
    expect(stored.depth_prompt).toBe(extensions.depth_prompt);
    expect(stored.vibe_tavern).toMatchObject({ other: { retained: true }, tracker_template: template });
    expect(readTrackerTemplate(stored)).toEqual(template);
    expect(withTrackerTemplate({ vibe_tavern: { tracker_template: template } }, null)).toEqual({});
  });

  test("rejects malformed, wrong-version, and empty templates", () => {
    expect(normalizeTrackerTemplate(null)).toBeNull();
    expect(normalizeTrackerTemplate([])).toBeNull();
    expect(normalizeTrackerTemplate({ version: 2, scene: {} })).toBeNull();
    expect(normalizeTrackerTemplate({ version: 1 })).toBeNull();
    expect(readTrackerTemplate({ vibe_tavern: { tracker_template: { version: "1", scene: {} } } })).toBeNull();
  });
});
