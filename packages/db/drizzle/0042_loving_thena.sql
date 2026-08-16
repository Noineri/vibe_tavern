ALTER TABLE `experience_copilot_threads` ADD `context_metrics_json` text;--> statement-breakpoint
ALTER TABLE `experience_copilot_threads` ADD `last_provider_profile_id` text;--> statement-breakpoint
ALTER TABLE `experience_copilot_threads` ADD `last_model` text;--> statement-breakpoint
ALTER TABLE `experience_copilot_threads` ADD `auto_compact` integer DEFAULT 1 NOT NULL;