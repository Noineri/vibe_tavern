ALTER TABLE `provider_profiles` ADD `unified_linear` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `unified_quad` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `unified_conf` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `repetition_penalty_slope` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `phrase_rep_pen` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `thinking_mode` text DEFAULT 'auto' NOT NULL;