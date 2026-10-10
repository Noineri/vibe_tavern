import {
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

const objectiveTemplateStateSchema = z.object({
  mode: z.enum([OBJECTIVE_MODE.route, OBJECTIVE_MODE.goals]).default(OBJECTIVE_MODE.route),
  objectiveDescription: z.string().default(""),
  tasks: z.array(objectiveItemSchema).default(() => []),
  longTermGoal: objectiveLongTermGoalSchema.nullable().default(null),
  shortTermGoals: z.array(objectiveItemSchema).default(() => []),
  autoCheckFrequency: z.number().int().min(0).default(0),
  contextWindow: z.number().int().min(1).default(5),
  injectionDepth: z.number().int().min(1).default(1),
  generatePrompt: z.string().default(""),
  checkPrompt: z.string().default(""),
  injectPrompt: z.string().default(""),
}).strict();

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
