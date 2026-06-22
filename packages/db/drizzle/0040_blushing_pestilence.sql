CREATE TABLE `provider_model_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_profile_id` text NOT NULL,
	`model_id` text NOT NULL,
	`settings_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`provider_profile_id`) REFERENCES `provider_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_provider_model_settings_unique` ON `provider_model_settings` (`provider_profile_id`,`model_id`);--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `bind_per_model` integer DEFAULT false NOT NULL;