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
    const routeTemplate = normalizeTrackerTemplate({
      version: 1,
      objective: {
        enabled: true,
        state: {
          tasks: [{ id: "task_1", description: "Complete it", status: "active" }],
        },
      },
    });

    expect(routeTemplate?.objective?.state.mode).toBe("route");
    expect(routeTemplate?.objective?.state).toEqual({
      mode: "route",
      objectiveDescription: "",
      tasks: [{ id: "task_1", description: "Complete it", status: "pending" }],
      autoCheckFrequency: 0,
      contextWindow: 5,
      injectionDepth: 1,
      generatePrompt: "",
      checkPrompt: "",
      injectPrompt: "",
    });

    const goalsTemplate = normalizeTrackerTemplate({
      version: 1,
      objective: {
        enabled: true,
        state: {
          mode: "goals",
          shortTermGoals: [{ id: "goal_1", description: "Start it", status: "completed" }],
          longTermGoal: { description: "Finish it", status: "abandoned" },
        },
      },
    });

    expect(goalsTemplate?.objective?.state).toEqual({
      mode: "goals",
      objectiveDescription: "",
      shortTermGoals: [{ id: "goal_1", description: "Start it", status: "pending" }],
      longTermGoal: { description: "Finish it", status: "pending" },
      autoCheckFrequency: 0,
      contextWindow: 5,
      injectionDepth: 1,
      generatePrompt: "",
      checkPrompt: "",
      injectPrompt: "",
    });

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

  test("migrates a goals-mode template that parked its goals in tasks (Karl card)", () => {
    const template = normalizeTrackerTemplate({
      version: 1,
      objective: {
        enabled: true,
        state: {
          mode: "goals",
          objectiveDescription: "Survive the descent together",
          tasks: [
            { id: "goal_warm", description: "Warm her hands", status: "pending" },
            { id: "goal_evade", description: "Evade the sentry", status: "active" },
            { id: "goal_descend", description: "Descend to the vault", status: "completed" },
          ],
          shortTermGoals: [],
          longTermGoal: null,
        },
      },
    });

    const state = template?.objective?.state;
    expect(state?.mode).toBe("goals");
    expect(state).not.toHaveProperty("tasks");
    expect(state).toEqual({
      mode: "goals",
      objectiveDescription: "Survive the descent together",
      shortTermGoals: [
        { id: "goal_warm", description: "Warm her hands", status: "pending" },
        { id: "goal_evade", description: "Evade the sentry", status: "pending" },
        { id: "goal_descend", description: "Descend to the vault", status: "pending" },
      ],
      longTermGoal: null,
      autoCheckFrequency: 0,
      contextWindow: 5,
      injectionDepth: 1,
      generatePrompt: "",
      checkPrompt: "",
      injectPrompt: "",
    });
  });

  test("migrates a route-mode template that parked its tasks in shortTermGoals", () => {
    const template = normalizeTrackerTemplate({
      version: 1,
      objective: {
        enabled: true,
        state: {
          mode: "route",
          tasks: [],
          shortTermGoals: [{ id: "goal_1", description: "Start it", status: "completed" }],
          longTermGoal: { description: "Stray long-term goal", status: "pending" },
        },
      },
    });

    const state = template?.objective?.state;
    expect(state?.mode).toBe("route");
    expect(state).not.toHaveProperty("shortTermGoals");
    expect(state).not.toHaveProperty("longTermGoal");
    expect(state?.tasks).toEqual([{ id: "goal_1", description: "Start it", status: "pending" }]);
  });

  test("migration is idempotent — normalizing a healed template is a no-op", () => {
    const healed = normalizeTrackerTemplate({
      version: 1,
      objective: {
        enabled: true,
        state: {
          mode: "goals",
          tasks: [{ id: "goal_1", description: "Find the road", status: "pending" }],
          shortTermGoals: [],
        },
      },
    })!;

    expect(healed.objective?.state).not.toHaveProperty("tasks");
    const renormalized = normalizeTrackerTemplate(healed)!;
    expect(renormalized).toEqual(healed);
    expect(JSON.stringify(renormalized)).toBe(JSON.stringify(healed));
  });

  test("discards the foreign list when both lists are non-empty — declared data wins, no merging", () => {
    const goalsTemplate = normalizeTrackerTemplate({
      version: 1,
      objective: {
        enabled: true,
        state: {
          mode: "goals",
          tasks: [{ id: "task_stray", description: "Stray task", status: "pending" }],
          shortTermGoals: [{ id: "goal_kept", description: "Declared goal", status: "pending" }],
        },
      },
    });
    const goalsState = goalsTemplate?.objective?.state;
    expect(goalsState?.mode).toBe("goals");
    expect(goalsState).not.toHaveProperty("tasks");
    expect(goalsState?.shortTermGoals).toEqual([{ id: "goal_kept", description: "Declared goal", status: "pending" }]);

    const routeTemplate = normalizeTrackerTemplate({
      version: 1,
      objective: {
        enabled: true,
        state: {
          mode: "route",
          tasks: [{ id: "task_kept", description: "Declared task", status: "pending" }],
          shortTermGoals: [{ id: "goal_stray", description: "Stray goal", status: "pending" }],
        },
      },
    });
    const routeState = routeTemplate?.objective?.state;
    expect(routeState?.mode).toBe("route");
    expect(routeState).not.toHaveProperty("shortTermGoals");
    expect(routeState?.tasks).toEqual([{ id: "task_kept", description: "Declared task", status: "pending" }]);
  });

  test("apply and re-extract round trip correct templates byte-identically in both modes", () => {
    const routeTemplate = normalizeTrackerTemplate({
      version: 1,
      objective: {
        enabled: true,
        state: {
          mode: "route",
          objectiveDescription: "Cross the wastes",
          tasks: [
            { id: "task_1", description: "Find water", status: "active" },
            { id: "task_2", description: "Reach the pass", status: "pending" },
          ],
          autoCheckFrequency: 2,
          contextWindow: 7,
          injectionDepth: 3,
          generatePrompt: "Generate route",
          checkPrompt: "Check route",
          injectPrompt: "Inject route",
        },
      },
    })!;

    const routeApplied = applyTrackerTemplate(routeTemplate, {
      insightsConfig: normalizeInsightsConfig({}),
      objectiveState: defaultObjectiveState(),
    });
    expect(routeApplied.objectiveState).toEqual({
      mode: "route",
      objectiveDescription: "Cross the wastes",
      tasks: [
        { id: "task_1", description: "Find water", status: "pending" },
        { id: "task_2", description: "Reach the pass", status: "pending" },
      ],
      longTermGoal: null,
      shortTermGoals: [],
      autoCheckFrequency: 2,
      autoCheckEventCount: 0,
      contextWindow: 7,
      injectionDepth: 3,
      generatePrompt: "Generate route",
      checkPrompt: "Check route",
      injectPrompt: "Inject route",
      useChatModel: true,
      providerProfileId: null,
      model: null,
    });
    expect(trackerTemplateFromChat(routeApplied.insightsConfig, routeApplied.objectiveState)).toEqual(routeTemplate);
    expect(JSON.stringify(normalizeTrackerTemplate(routeTemplate))).toBe(JSON.stringify(routeTemplate));

    const goalsTemplate = normalizeTrackerTemplate({
      version: 1,
      objective: {
        enabled: true,
        state: {
          mode: "goals",
          objectiveDescription: "Reach the tower",
          shortTermGoals: [{ id: "goal_1", description: "Find the road", status: "active" }],
          longTermGoal: { description: "Defeat the wizard", status: "pending" },
          autoCheckFrequency: 3,
          contextWindow: 9,
          injectionDepth: 2,
          generatePrompt: "Generate goals",
          checkPrompt: "Check goals",
          injectPrompt: "Inject goals",
        },
      },
    })!;

    const goalsApplied = applyTrackerTemplate(goalsTemplate, {
      insightsConfig: normalizeInsightsConfig({}),
      objectiveState: defaultObjectiveState(),
    });
    expect(goalsApplied.objectiveState).toEqual({
      mode: "goals",
      objectiveDescription: "Reach the tower",
      tasks: [],
      longTermGoal: { description: "Defeat the wizard", status: "pending" },
      shortTermGoals: [{ id: "goal_1", description: "Find the road", status: "pending" }],
      autoCheckFrequency: 3,
      autoCheckEventCount: 0,
      contextWindow: 9,
      injectionDepth: 2,
      generatePrompt: "Generate goals",
      checkPrompt: "Check goals",
      injectPrompt: "Inject goals",
      useChatModel: true,
      providerProfileId: null,
      model: null,
    });
    expect(trackerTemplateFromChat(goalsApplied.insightsConfig, goalsApplied.objectiveState)).toEqual(goalsTemplate);
    expect(JSON.stringify(normalizeTrackerTemplate(goalsTemplate))).toBe(JSON.stringify(goalsTemplate));
  });

  test("chat extraction projects only the declared mode's list — the foreign list is dropped", () => {
    // Runtime chat state legitimately carries both lists at once; the
    // template must carry only the declared mode's slots.
    const goalsChat = trackerTemplateFromChat(
      normalizeInsightsConfig({ objectiveEnabled: true }),
      normalizeObjectiveState({
        mode: "goals",
        tasks: [{ id: "task_stale", description: "Stale route task", status: "active" }],
        shortTermGoals: [{ id: "goal_1", description: "Active goal", status: "pending" }],
        longTermGoal: { description: "The end", status: "pending" },
      }),
    );
    const goalsState = goalsChat?.objective?.state;
    expect(goalsState?.mode).toBe("goals");
    expect(goalsState).not.toHaveProperty("tasks");
    expect(goalsState?.shortTermGoals).toEqual([{ id: "goal_1", description: "Active goal", status: "pending" }]);
    expect(goalsState?.longTermGoal).toEqual({ description: "The end", status: "pending" });

    const routeChat = trackerTemplateFromChat(
      normalizeInsightsConfig({ objectiveEnabled: true }),
      normalizeObjectiveState({
        mode: "route",
        tasks: [{ id: "task_1", description: "Declared task", status: "active" }],
        shortTermGoals: [{ id: "goal_stale", description: "Stale goal", status: "pending" }],
        longTermGoal: { description: "Stale long-term goal", status: "pending" },
      }),
    );
    const routeChatState = routeChat?.objective?.state;
    expect(routeChatState?.mode).toBe("route");
    expect(routeChatState).not.toHaveProperty("shortTermGoals");
    expect(routeChatState).not.toHaveProperty("longTermGoal");
    expect(routeChatState?.tasks).toEqual([{ id: "task_1", description: "Declared task", status: "pending" }]);
  });

  test("an otherwise-default goals state counts as default for template extraction", () => {
    // Per-mode default comparison (CT-9): a goals-mode state whose slots are
    // all default is still "default" — the mode alone no longer pins a
    // template section onto the card.
    const template = trackerTemplateFromChat(
      normalizeInsightsConfig({ objectiveEnabled: false }),
      { ...defaultObjectiveState(), mode: "goals" },
    );
    expect(template).toBeNull();
  });
});
