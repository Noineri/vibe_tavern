CREATE TABLE `regex_profile_links` (
	`regex_profile_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	PRIMARY KEY(`regex_profile_id`, `target_type`, `target_id`),
	FOREIGN KEY (`regex_profile_id`) REFERENCES `regex_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_regex_profile_links_target` ON `regex_profile_links` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_regex_profile_links_profile` ON `regex_profile_links` (`regex_profile_id`);--> statement-breakpoint
CREATE TABLE `regex_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`disabled` integer DEFAULT 0 NOT NULL,
	`is_global` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_regex_profiles_global` ON `regex_profiles` (`is_global`);--> statement-breakpoint
ALTER TABLE `regex_presets` ADD `profile_id` text REFERENCES `regex_profiles`(`id`) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `idx_regex_presets_profile` ON `regex_presets` (`profile_id`);