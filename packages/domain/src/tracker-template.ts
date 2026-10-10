import type {
  InsightsConfig,
  ObjectiveLongTermGoal,
  ObjectiveShortTermGoal,
  ObjectiveState,
  ObjectiveTask,
  SceneTrackerConfig,
} from "./entities.js";
import { defaultObjectiveState, normalizeObjectiveState } from "./chat-json-config.js";
import { OBJECTIVE_MODE, OBJECTIVE_TASK_STATUS } from "./platform-constants.js";
import { applySceneTrackerConfigPatch, normalizeSceneTrackerConfig } from "./scene-tracker-constants.js";

export const TRACKER_TEMPLATE_VERSION = 1 as const;
export const VT_EXTENSION_KEY = "vibe_tavern";
export const TRACKER_TEMPLATE_KEY = "tracker_template";

export type SceneTrackerTemplateConfig = Omit<
  SceneTrackerConfig,
  "useChatModel" | "providerProfileId" | "model" | "revision" | "schemaHash"
>;

/**
 * Route-mode objective template state (CT-9): carries `tasks` only — the
 * template is the portable transport shape, so the mode's foreign slots are
 * absent, not empty. Mirrors the api-contracts union branch structurally
 * (domain is the dependency leaf and cannot import it).
 */
export interface RouteObjectiveTemplateState {
  mode: typeof OBJECTIVE_MODE.route;
  objectiveDescription: string;
  tasks: ObjectiveTask[];
  autoCheckFrequency: number;
  contextWindow: number;
  injectionDepth: number;
  generatePrompt: string;
  checkPrompt: string;
  injectPrompt: string;
}

/**
 * Goals-mode objective template state (CT-9): carries `shortTermGoals` +
 * `longTermGoal` only (see {@link RouteObjectiveTemplateState}).
 */
export interface GoalsObjectiveTemplateState {
  mode: typeof OBJECTIVE_MODE.goals;
  objectiveDescription: string;
  shortTermGoals: ObjectiveShortTermGoal[];
  longTermGoal: ObjectiveLongTermGoal | null;
  autoCheckFrequency: number;
  contextWindow: number;
  injectionDepth: number;
  generatePrompt: string;
  checkPrompt: string;
  injectPrompt: string;
}

export type ObjectiveTemplateState = RouteObjectiveTemplateState | GoalsObjectiveTemplateState;

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

/** Chat state → template: project ONLY the declared mode's list; statuses reset to pending. */
function objectiveTemplateState(state: ObjectiveState): ObjectiveTemplateState {
  const normalized = normalizeObjectiveState(state);
  if (normalized.mode === OBJECTIVE_MODE.goals) {
    return {
      mode: OBJECTIVE_MODE.goals,
      objectiveDescription: normalized.objectiveDescription,
      shortTermGoals: normalized.shortTermGoals.map((goal) => ({ ...goal, status: OBJECTIVE_TASK_STATUS.pending })),
      longTermGoal: normalized.longTermGoal === null
        ? null
        : { ...normalized.longTermGoal, status: OBJECTIVE_TASK_STATUS.pending },
      autoCheckFrequency: normalized.autoCheckFrequency,
      contextWindow: normalized.contextWindow,
      injectionDepth: normalized.injectionDepth,
      generatePrompt: normalized.generatePrompt,
      checkPrompt: normalized.checkPrompt,
      injectPrompt: normalized.injectPrompt,
    };
  }
  return {
    mode: OBJECTIVE_MODE.route,
    objectiveDescription: normalized.objectiveDescription,
    tasks: normalized.tasks.map((task) => ({ ...task, status: OBJECTIVE_TASK_STATUS.pending })),
    autoCheckFrequency: normalized.autoCheckFrequency,
    contextWindow: normalized.contextWindow,
    injectionDepth: normalized.injectionDepth,
    generatePrompt: normalized.generatePrompt,
    checkPrompt: normalized.checkPrompt,
    injectPrompt: normalized.injectPrompt,
  };
}

function isDefaultObjectiveTemplateState(state: ObjectiveTemplateState): boolean {
  const base = defaultObjectiveState();
  const defaultState = objectiveTemplateState(
    state.mode === OBJECTIVE_MODE.goals ? { ...base, mode: OBJECTIVE_MODE.goals } : base,
  );
  return JSON.stringify(state) === JSON.stringify(defaultState);
}

/**
 * CT-9 legacy healing at the RAW level, before typed normalization: a
 * goals-mode payload that parked its goals in `tasks` (the live Karl card)
 * moves them to `shortTermGoals`; a route-mode payload with populated
 * `shortTermGoals` moves them to `tasks`. The foreign list moves only when the
 * declared slot is empty; when BOTH are non-empty the foreign list is
 * DISCARDED (declared data wins — no merging). Works on unknown input, so it
 * also heals mis-slotted templates arriving through the tool/schema surface.
 */
function migrateObjectiveTemplateRawState(raw: unknown): unknown {
  if (!isPlainRecord(raw)) return raw;
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  const shortTermGoals = Array.isArray(raw.shortTermGoals) ? raw.shortTermGoals : [];
  if (raw.mode === OBJECTIVE_MODE.goals) {
    if (tasks.length === 0) return raw;
    if (shortTermGoals.length > 0) {
      const { tasks: discardedTasks, ...rest } = raw;
      return rest;
    }
    const { tasks: movedTasks, ...rest } = raw;
    return { ...rest, shortTermGoals: movedTasks };
  }
  if (shortTermGoals.length === 0) return raw;
  if (tasks.length > 0) {
    const { shortTermGoals: discardedGoals, ...rest } = raw;
    return rest;
  }
  const { shortTermGoals: movedGoals, ...rest } = raw;
  return { ...rest, tasks: movedGoals };
}

/** Template → chat runtime state: foreign slots become empty; both lists always present. */
function runtimeObjectiveState(state: ObjectiveTemplateState): ObjectiveState {
  return {
    mode: state.mode,
    objectiveDescription: state.objectiveDescription,
    tasks: state.mode === OBJECTIVE_MODE.route ? state.tasks : [],
    longTermGoal: state.mode === OBJECTIVE_MODE.goals ? state.longTermGoal : null,
    shortTermGoals: state.mode === OBJECTIVE_MODE.goals ? state.shortTermGoals : [],
    autoCheckFrequency: state.autoCheckFrequency,
    autoCheckEventCount: 0,
    contextWindow: state.contextWindow,
    injectionDepth: state.injectionDepth,
    generatePrompt: state.generatePrompt,
    checkPrompt: state.checkPrompt,
    injectPrompt: state.injectPrompt,
    useChatModel: true,
    providerProfileId: null,
    model: null,
  };
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
        state: objectiveTemplateState(
          normalizeObjectiveState(migrateObjectiveTemplateRawState(raw.objective.state)),
        ),
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
    objectiveState = runtimeObjectiveState(template.objective.state);
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
