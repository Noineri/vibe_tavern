CREATE TABLE `image_prompt_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`row_key` text NOT NULL,
	`family` text NOT NULL,
	`body` text NOT NULL,
	`quality_text` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_image_prompt_variants_unique` ON `image_prompt_variants` (`row_key`,`family`);