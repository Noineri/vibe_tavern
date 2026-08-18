ALTER TABLE `experience_chat_configs` ADD `context_source_persona_id` text REFERENCES `personas`(`id`) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `experience_context_bundles` ADD `source_persona_id` text;
