ALTER TABLE `provider_profiles` ADD `model_free_only` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `model_group_by_owner` integer DEFAULT false NOT NULL;