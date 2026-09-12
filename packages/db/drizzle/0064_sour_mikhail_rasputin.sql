ALTER TABLE `provider_profiles` ADD `dynatemp_range` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `dynatemp_exponent` real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `top_n_sigma` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `smoothing_factor` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `dry_penalty_last_n` integer DEFAULT -1 NOT NULL;