/**
 * Registry of the app's base "service" (служебные) system prompts.
 *
 * This module drives the Service Prompt Profiles feature (dedicated
 * tab, independent from prompt presets, globally active profile).
 * Domain holds keys + families only — the key -> asset-file map and
 * resolution order live server-side (service-prompt-resolver).
 */

export const SERVICE_PROMPT_FIELD_FAMILIES = {
  assistant: "assistant",
  summary: "summary",
  insights: "insights",
  bases: "bases",
  images: "images",
} as const;
export type ServicePromptFieldFamily =
  (typeof SERVICE_PROMPT_FIELD_FAMILIES)[keyof typeof SERVICE_PROMPT_FIELD_FAMILIES];

export const SERVICE_PROMPT_FIELDS = {
  // assistant (12)
  script: { family: SERVICE_PROMPT_FIELD_FAMILIES.assistant },
  dice_script: { family: SERVICE_PROMPT_FIELD_FAMILIES.assistant },
  lore_entry: { family: SERVICE_PROMPT_FIELD_FAMILIES.assistant },
  lore_keys: { family: SERVICE_PROMPT_FIELD_FAMILIES.assistant },
  chat_impersonate: { family: SERVICE_PROMPT_FIELD_FAMILIES.assistant },
  md_import: { family: SERVICE_PROMPT_FIELD_FAMILIES.assistant },
  vision_describe: { family: SERVICE_PROMPT_FIELD_FAMILIES.assistant },
  scene_schema: { family: SERVICE_PROMPT_FIELD_FAMILIES.assistant },
  scene_rules: { family: SERVICE_PROMPT_FIELD_FAMILIES.assistant },
  message_edit: { family: SERVICE_PROMPT_FIELD_FAMILIES.assistant },
  message_merge: { family: SERVICE_PROMPT_FIELD_FAMILIES.assistant },
  message_tts_annotate: { family: SERVICE_PROMPT_FIELD_FAMILIES.assistant },
  // assistant (12) — regex-rule authoring (REGEX_AI_ASSISTANT_PLAN)
  regex: { family: SERVICE_PROMPT_FIELD_FAMILIES.assistant },
  // summary (1)
  summary: { family: SERVICE_PROMPT_FIELD_FAMILIES.summary },
  // insights (4)
  objective_generate: { family: SERVICE_PROMPT_FIELD_FAMILIES.insights },
  objective_generate_goals: { family: SERVICE_PROMPT_FIELD_FAMILIES.insights },
  objective_check: { family: SERVICE_PROMPT_FIELD_FAMILIES.insights },
  scene_generate: { family: SERVICE_PROMPT_FIELD_FAMILIES.insights },
  // bases (5)
  coauthor_base: { family: SERVICE_PROMPT_FIELD_FAMILIES.bases },
  copilot_base: { family: SERVICE_PROMPT_FIELD_FAMILIES.bases },
  copilot_user_flow: { family: SERVICE_PROMPT_FIELD_FAMILIES.bases },
  interactive_rules: { family: SERVICE_PROMPT_FIELD_FAMILIES.bases },
  interactive_visual: { family: SERVICE_PROMPT_FIELD_FAMILIES.bases },
  // images (8) — one template per v1 generation mode + the shared negative
  // default + the LLM-assist instruction (IMAGE_GENERATION_PLAN IG-13/IG-15;
  // mode intent mirrors the design doc). image_assist is the quiet pre-pass
  // SYSTEM prompt (an LLM instruction, unlike the mode payloads below).
  image_scene_background: { family: SERVICE_PROMPT_FIELD_FAMILIES.images },
  image_portrait: { family: SERVICE_PROMPT_FIELD_FAMILIES.images },
  image_character: { family: SERVICE_PROMPT_FIELD_FAMILIES.images },
  image_user_persona: { family: SERVICE_PROMPT_FIELD_FAMILIES.images },
  image_scene_illustration: { family: SERVICE_PROMPT_FIELD_FAMILIES.images },
  image_free: { family: SERVICE_PROMPT_FIELD_FAMILIES.images },
  image_negative: { family: SERVICE_PROMPT_FIELD_FAMILIES.images },
  image_assist: { family: SERVICE_PROMPT_FIELD_FAMILIES.images },
} as const;

export type ServicePromptFieldKey = keyof typeof SERVICE_PROMPT_FIELDS;

export const SERVICE_PROMPT_FIELD_KEYS = [
  "script",
  "dice_script",
  "lore_entry",
  "lore_keys",
  "chat_impersonate",
  "md_import",
  "vision_describe",
  "scene_schema",
  "scene_rules",
  "message_edit",
  "message_merge",
  "message_tts_annotate",
  "regex",
  "summary",
  "objective_generate",
  "objective_generate_goals",
  "objective_check",
  "scene_generate",
  "coauthor_base",
  "copilot_base",
  "copilot_user_flow",
  "interactive_rules",
  "interactive_visual",
  "image_scene_background",
  "image_portrait",
  "image_character",
  "image_user_persona",
  "image_scene_illustration",
  "image_free",
  "image_negative",
  "image_assist",
] as const satisfies readonly ServicePromptFieldKey[];
