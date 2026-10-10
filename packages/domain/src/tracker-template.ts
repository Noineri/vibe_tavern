import type { InsightsConfig, ObjectiveState, SceneTrackerConfig } from "./entities.js";
import { defaultObjectiveState, normalizeObjectiveState } from "./chat-json-config.js";
import { OBJECTIVE_TASK_STATUS } from "./platform-constants.js";
import { applySceneTrackerConfigPatch, normalizeSceneTrackerConfig } from "./scene-tracker-constants.js";

export const TRACKER_TEMPLATE_VERSION = 1 as const;
export const VT_EXTENSION_KEY = "vibe_tavern";
export const TRACKER_TEMPLATE_KEY = "tracker_template";

export type SceneTrackerTemplateConfig = Omit<
  SceneTrackerConfig,
  "useChatModel" | "providerProfileId" | "model" | "revision" | "schemaHash"
>;

export type ObjectiveTemplateState = Omit<
  ObjectiveState,
  "useChatModel" | "providerProfileId" | "model" | "autoCheckEventCount"
>;

export interface TrackerTemplate {
  version: typeof TRACKER_TEMPLATE_VERSION;
  scene: { enabled: boolean; config: SceneTrackerTemplateConfig } | null;
  objective: { enabled: boolean; state: ObjectiveTemplateState } | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sceneTemplateConfig(config: SceneTrackerConfig): SceneTrackerTemplateConfig {
  const { useChatModel, providerProfileId, model, revision, schemaHash, ...templateConfig } = config;
  return templateConfig;
}

function objectiveTemplateState(state: ObjectiveState): ObjectiveTemplateState {
  const normalized = normalizeObjectiveState(state);
  const { useChatModel, providerProfileId, model, autoCheckEventCount, ...templateState } = normalized;
  return {
    ...templateState,
    tasks: templateState.tasks.map((task) => ({ ...task, status: OBJECTIVE_TASK_STATUS.pending })),
    shortTermGoals: templateState.shortTermGoals.map((goal) => ({ ...goal, status: OBJECTIVE_TASK_STATUS.pending })),
    longTermGoal: templateState.longTermGoal === null
      ? null
      : { ...templateState.longTermGoal, status: OBJECTIVE_TASK_STATUS.pending },
  };
}

function isDefaultObjectiveTemplateState(state: ObjectiveTemplateState): boolean {
  const defaultState = objectiveTemplateState(defaultObjectiveState());
  return JSON.stringify(state) === JSON.stringify(defaultState);
}

export function normalizeTrackerTemplate(raw: unknown): TrackerTemplate | null {
  if (!isPlainRecord(raw) || raw.version !== TRACKER_TEMPLATE_VERSION) return null;

  const scene = isPlainRecord(raw.scene)
    ? {
        enabled: raw.scene.enabled === true,
        config: sceneTemplateConfig(normalizeSceneTrackerConfig(raw.scene.config)),
      }
    : null;
  const objective = isPlainRecord(raw.objective)
    ? {
        enabled: raw.objective.enabled === true,
        state: objectiveTemplateState(normalizeObjectiveState(raw.objective.state)),
      }
    : null;

  if (scene === null && objective === null) return null;
  return { version: TRACKER_TEMPLATE_VERSION, scene, objective };
}

export function trackerTemplateFromChat(
  insightsConfig: InsightsConfig,
  objectiveState: ObjectiveState,
): TrackerTemplate | null {
  const scene = insightsConfig.tracker === undefined && !insightsConfig.trackerEnabled
    ? null
    : {
        enabled: insightsConfig.trackerEnabled,
        config: sceneTemplateConfig(normalizeSceneTrackerConfig(insightsConfig.tracker)),
      };
  const objectiveStateTemplate = objectiveTemplateState(objectiveState);
  const objective = !insightsConfig.objectiveEnabled && isDefaultObjectiveTemplateState(objectiveStateTemplate)
    ? null
    : { enabled: insightsConfig.objectiveEnabled, state: objectiveStateTemplate };

  if (scene === null && objective === null) return null;
  return { version: TRACKER_TEMPLATE_VERSION, scene, objective };
}

export function applyTrackerTemplate(
  template: TrackerTemplate,
  current: { insightsConfig: InsightsConfig; objectiveState: ObjectiveState },
): { insightsConfig: InsightsConfig; objectiveState: ObjectiveState } {
  let insightsConfig = current.insightsConfig;
  let objectiveState = current.objectiveState;

  if (template.scene !== null) {
    insightsConfig = {
      ...insightsConfig,
      trackerEnabled: template.scene.enabled,
      tracker: applySceneTrackerConfigPatch(
        normalizeSceneTrackerConfig(current.insightsConfig.tracker),
        {
          ...template.scene.config,
          useChatModel: true,
          providerProfileId: null,
          model: null,
        },
      ),
    };
  }

  if (template.objective !== null) {
    objectiveState = {
      ...template.objective.state,
      useChatModel: true,
      providerProfileId: null,
      model: null,
      autoCheckEventCount: 0,
    };
    insightsConfig = { ...insightsConfig, objectiveEnabled: template.objective.enabled };
  }

  return { insightsConfig, objectiveState };
}

export function readTrackerTemplate(extensions: Record<string, unknown>): TrackerTemplate | null {
  const vibeTavern = extensions[VT_EXTENSION_KEY];
  if (!isPlainRecord(vibeTavern)) return null;
  return normalizeTrackerTemplate(vibeTavern[TRACKER_TEMPLATE_KEY]);
}

export function withTrackerTemplate(
  extensions: Record<string, unknown>,
  template: TrackerTemplate | null,
): Record<string, unknown> {
  const vibeTavern = extensions[VT_EXTENSION_KEY];
  if (!isPlainRecord(vibeTavern)) {
    if (template === null) return { ...extensions };
    return {
      ...extensions,
      [VT_EXTENSION_KEY]: { [TRACKER_TEMPLATE_KEY]: template },
    };
  }

  if (template !== null) {
    return {
      ...extensions,
      [VT_EXTENSION_KEY]: {
        ...vibeTavern,
        [TRACKER_TEMPLATE_KEY]: template,
      },
    };
  }

  const { [TRACKER_TEMPLATE_KEY]: removedTemplate, ...remainingVibeTavern } = vibeTavern;
  if (Object.keys(remainingVibeTavern).length > 0) {
    return { ...extensions, [VT_EXTENSION_KEY]: remainingVibeTavern };
  }

  const { [VT_EXTENSION_KEY]: removedVibeTavern, ...remainingExtensions } = extensions;
  return remainingExtensions;
}
