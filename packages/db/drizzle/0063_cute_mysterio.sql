ALTER TABLE `provider_profiles` ADD `adaptive_target` real DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `adaptive_decay` real DEFAULT 0.9 NOT NULL;