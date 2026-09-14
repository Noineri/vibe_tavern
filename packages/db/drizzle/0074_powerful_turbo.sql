CREATE TABLE `image_gen_model_favorites` (
	`id` text PRIMARY KEY NOT NULL,
	`image_gen_profile_id` text NOT NULL,
	`model_id` text NOT NULL,
	`label` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`image_gen_profile_id`) REFERENCES `image_gen_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_image_gen_model_favorites_unique` ON `image_gen_model_favorites` (`image_gen_profile_id`,`model_id`);--> statement-breakpoint
CREATE TABLE `image_gen_model_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`image_gen_profile_id` text NOT NULL,
	`model_id` text NOT NULL,
	`settings_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`image_gen_profile_id`) REFERENCES `image_gen_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_image_gen_model_settings_unique` ON `image_gen_model_settings` (`image_gen_profile_id`,`model_id`);