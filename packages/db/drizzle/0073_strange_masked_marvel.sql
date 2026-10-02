CREATE TABLE `image_gen_links` (
	`image_gen_profile_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	PRIMARY KEY(`image_gen_profile_id`, `target_type`, `target_id`),
	FOREIGN KEY (`image_gen_profile_id`) REFERENCES `image_gen_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_image_gen_links_target` ON `image_gen_links` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_image_gen_links_profile` ON `image_gen_links` (`image_gen_profile_id`);--> statement-breakpoint
CREATE TABLE `image_gen_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`backend` text NOT NULL,
	`preset_id` text,
	`endpoint` text NOT NULL,
	`api_key` text,
	`model_id` text,
	`default_params_json` text DEFAULT '{}' NOT NULL,
	`mode_size_presets_json` text DEFAULT '{}' NOT NULL,
	`llm_assist_enabled` integer DEFAULT false NOT NULL,
	`llm_provider_profile_id` text,
	`llm_model_id` text,
	`capabilities_json` text DEFAULT '{}' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_image_gen_profiles_backend` ON `image_gen_profiles` (`backend`);