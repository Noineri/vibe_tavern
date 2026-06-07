ALTER TABLE `provider_profiles` ADD `typical_p` real NOT NULL DEFAULT 1.0;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `tfs_z` real NOT NULL DEFAULT 1.0;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `repeat_last_n` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `mirostat` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `mirostat_tau` real NOT NULL DEFAULT 5.0;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `mirostat_eta` real NOT NULL DEFAULT 0.1;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `dry_multiplier` real NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `dry_base` real NOT NULL DEFAULT 1.75;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `dry_allowed_length` integer NOT NULL DEFAULT 2;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `dry_sequence_breakers_json` text;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `xtc_threshold` real NOT NULL DEFAULT 0.1;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `xtc_probability` real NOT NULL DEFAULT 0;
