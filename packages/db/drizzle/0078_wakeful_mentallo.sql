ALTER TABLE `image_gen_profiles` ADD `is_default` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_image_gen_profiles_default` ON `image_gen_profiles` (`is_default`);