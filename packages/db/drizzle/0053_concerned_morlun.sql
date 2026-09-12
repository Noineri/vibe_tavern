CREATE TABLE `tts_profile_links` (
	`tts_profile_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	PRIMARY KEY(`tts_profile_id`, `target_type`, `target_id`),
	FOREIGN KEY (`tts_profile_id`) REFERENCES `tts_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tts_profile_links_target` ON `tts_profile_links` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_tts_profile_links_profile` ON `tts_profile_links` (`tts_profile_id`);--> statement-breakpoint
CREATE TABLE `tts_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`backend` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`voice_id` text DEFAULT '' NOT NULL,
	`lang` text DEFAULT 'en' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tts_profiles_default` ON `tts_profiles` (`is_default`);--> statement-breakpoint
CREATE INDEX `idx_tts_profiles_backend` ON `tts_profiles` (`backend`);