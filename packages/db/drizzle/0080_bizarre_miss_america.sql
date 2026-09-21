ALTER TABLE `image_gen_profiles` ADD `family_override` text;--> statement-breakpoint
ALTER TABLE `image_gen_profiles` ADD `family_detected` text;--> statement-breakpoint
ALTER TABLE `image_gen_profiles` ADD `family_detected_for_model` text;--> statement-breakpoint
ALTER TABLE `image_gen_profiles` ADD `quality_layer_enabled` integer DEFAULT false NOT NULL;