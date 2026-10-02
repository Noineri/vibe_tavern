CREATE TABLE `image_prompt_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`overrides` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `ui_settings` ADD `active_image_prompt_profile_id` text;--> statement-breakpoint
ALTER TABLE `ui_settings` ADD `image_prompt_variants_migrated` integer DEFAULT false NOT NULL;