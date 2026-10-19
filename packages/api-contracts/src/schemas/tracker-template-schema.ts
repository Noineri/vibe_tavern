import {
  isRecord,
  OBJECTIVE_MODE,
  OBJECTIVE_TASK_STATUS,
  SCENE_AUTO_MODE,
  SCENE_PROMPT_FORMAT,
} from "@vibe-tavern/domain";
import { z } from "zod";
import { sceneTrackerDslSchema } from "./tracker-schema.js";

const objectiveTaskStatusSchema = z.enum([
  OBJECTIVE_TASK_STATUS.pending,
  OBJECTIVE_TASK_STATUS.active,
  OBJECTIVE_TASK_STATUS.completed,
  OBJECTIVE_TASK_STATUS.abandoned,
]);

const objectiveItemSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: objectiveTaskStatusSchema,
}).strict();

const objectiveLongTermGoalSchema = z.object({
  description: z.string(),
  status: objectiveTaskStatusSchema,
}).strict();

const sceneTrackerTemplateConfigSchema = z.object({
  schema: sceneTrackerDslSchema.default(() => ({})),
  autoMode: z.enum([SCENE_AUTO_MODE.assistant, SCENE_AUTO_MODE.manual]).default(SCENE_AUTO_MODE.assistant),
  contextWindow: z.number().int().min(1).default(6),
  continuityLastN: z.number().int().min(0).default(3),
  injectionDepth: z.number().int().min(1).default(1),
  injectLastN: z.number().int().min(0).default(1),
  promptFormat: z.enum([SCENE_PROMPT_FORMAT.json, SCENE_PROMPT_FORMAT.xml]).default(SCENE_PROMPT_FORMAT.json),
  generatePrompt: z.string().default(""),
  injectPrompt: z.string().default(""),
  rulesPrompt: z.string().default(""),
}).strict();

/**
 * Objective template fields shared by both mode branches (CT-9): the union
 * discriminates only the goal-carrying slots; everything else is identical.
 * Single source for both branches below.
 */
const objectiveTemplateStateScalars = {
  autoCheckFrequency: z.number().int().min(0).default(0),
  contextWindow: z.number().int().min(1).default(5),
  injectionDepth: z.number().int().min(1).default(1),
  generatePrompt: z.string().default(""),
  checkPrompt: z.string().default(""),
  injectPrompt: z.string().default(""),
};

/**
 * Route branch of the objective template state (CT-9): carries `tasks` ONLY.
 * Strict, so a `shortTermGoals`/`longTermGoal` key here surfaces as an
 * "Unrecognized key" error naming the field — a mis-slotted goal list becomes
 * a precise self-correction target instead of a silently ignored slot.
 */
const routeObjectiveTemplateStateSchema = z.object({
  mode: z.literal(OBJECTIVE_MODE.route),
  objectiveDescription: z.string().default(""),
  tasks: z.array(objectiveItemSchema).default(() => []),
  ...objectiveTemplateStateScalars,
}).strict();

/**
 * Goals branch of the objective template state (CT-9): carries
 * `shortTermGoals` + `longTermGoal` ONLY; a `tasks` key here is an
 * "Unrecognized key" error naming the field (see the route branch).
 */
const goalsObjectiveTemplateStateSchema = z.object({
  mode: z.literal(OBJECTIVE_MODE.goals),
  objectiveDescription: z.string().default(""),
  shortTermGoals: z.array(objectiveItemSchema).default(() => []),
  longTermGoal: objectiveLongTermGoalSchema.nullable().default(null),
  ...objectiveTemplateStateScalars,
}).strict();

/**
 * Objective template state as a discriminated union on `mode` (CT-9). Parse
 * output is per-branch: a stored template carries only its mode's slots
 * (portability discipline — the domain normalizer heals legacy mis-slotted
 * payloads on read). The preprocess keeps the historical behavior that an
 * input without `mode` parses as route: zod unions do not apply defaults to a
 * MISSING discriminator, so the default is injected before the union runs.
 */
const objectiveTemplateStateSchema = z.preprocess(
  (value) => {
    if (isRecord(value) && value.mode === undefined) {
      return { ...value, mode: OBJECTIVE_MODE.route };
    }
    return value;
  },
  z.discriminatedUnion("mode", [
    routeObjectiveTemplateStateSchema,
    goalsObjectiveTemplateStateSchema,
  ]),
);

/** Portable scene/objective setup that omits machine-local provider choices. */
export const trackerTemplateSchema = z.object({
  // Version stays numeric at the transport boundary so domain normalization is
  // the one authority for supported template versions.
  version: z.number(),
  scene: z.object({
    enabled: z.boolean(),
    config: sceneTrackerTemplateConfigSchema,
  }).strict().nullable().default(null),
  objective: z.object({
    enabled: z.boolean(),
    state: objectiveTemplateStateSchema,
  }).strict().nullable().default(null),
}).strict();

export const updateTrackerTemplateSchema = z.object({
  template: trackerTemplateSchema,
}).strict();
