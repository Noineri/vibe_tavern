CREATE TABLE `stt_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`backend` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`api_key` text,
	`emotion_annotation` integer DEFAULT false NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_stt_profiles_default` ON `stt_profiles` (`is_default`);--> statement-breakpoint
CREATE INDEX `idx_stt_profiles_backend` ON `stt_profiles` (`backend`);--> statement-breakpoint
ALTER TABLE `ui_settings` ADD `active_dictation_profile_id` text;--> statement-breakpoint
ALTER TABLE `ui_settings` ADD `active_voice_message_profile_id` text;