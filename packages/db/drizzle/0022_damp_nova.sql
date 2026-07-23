DROP INDEX `idx_provider_model_favorites_unique`;--> statement-breakpoint
ALTER TABLE `provider_model_favorites` ADD `scope` text DEFAULT 'rp' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_provider_model_favorites_unique` ON `provider_model_favorites` (`provider_profile_id`,`model_id`,`scope`);