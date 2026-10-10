import type { ServicePromptFieldKey } from "@vibe-tavern/domain";

/**
 * Per-field i18n label keys for the Service Prompt Profiles pane.
 * A field without an entry falls back to
 * `promptManager.servicePrompts.field.${field}` at the call site.
 */
export const FIELD_LABEL_KEYS: Partial<Record<ServicePromptFieldKey, string>> = {
	script: "ai_assistant_mode_script",
	dice_script: "promptManager.servicePrompts.field.dice_script",
	lore_entry: "ai_assistant_mode_lore_entry",
	lore_keys: "ai_assistant_mode_lore_keys",
	chat_impersonate: "ai_assistant_mode_chat_impersonate",
	chat_impersonate_enhance: "promptManager.servicePrompts.field.chat_impersonate_enhance",
	md_import: "promptManager.servicePrompts.field.md_import",
	vision_describe: "ai_assistant_mode_vision_describe",
	scene_schema: "ai_assistant_mode_scene_schema",
	scene_rules: "promptManager.servicePrompts.field.scene_rules",
	message_edit: "ai_assistant_mode_message_edit",
	message_merge: "ai_assistant_mode_message_merge",
	message_tts_annotate: "ai_assistant_mode_message_tts_annotate",
	regex: "promptManager.servicePrompts.field.regex",
	summary: "promptManager.servicePrompts.field.summary",
	objective_generate: "promptManager.servicePrompts.field.objective_generate",
	objective_generate_goals: "promptManager.servicePrompts.field.objective_generate_goals",
	objective_check: "promptManager.servicePrompts.field.objective_check",
	scene_generate: "promptManager.servicePrompts.field.scene_generate",
	tracker_template: "promptManager.servicePrompts.field.tracker_template",
	coauthor_base: "promptManager.servicePrompts.field.coauthor_base",
	copilot_base: "promptManager.servicePrompts.field.copilot_base",
	copilot_user_flow: "promptManager.servicePrompts.field.copilot_user_flow",
	interactive_rules: "promptManager.servicePrompts.field.interactive_rules",
	interactive_visual: "promptManager.servicePrompts.field.interactive_visual",
};
