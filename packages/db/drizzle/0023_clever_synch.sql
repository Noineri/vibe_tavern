ALTER TABLE `prompt_presets` ADD `ai_assistant_prompts` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `ui_settings` ADD `ai_assistant_provider_id` text;--> statement-breakpoint
ALTER TABLE `ui_settings` ADD `ai_assistant_model_name` text;--> statement-breakpoint

-- Migrate non-empty scriptAiSystemPrompt values into aiAssistantPrompts
UPDATE `prompt_presets` SET `ai_assistant_prompts` = '{"script": "' || REPLACE(REPLACE(`script_ai_system_prompt`, '\', '\\'), '"', '\"') || '"}' WHERE `script_ai_system_prompt` IS NOT NULL AND TRIM(`script_ai_system_prompt`) != '';