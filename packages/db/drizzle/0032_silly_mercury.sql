CREATE TABLE `character_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`ext` text NOT NULL,
	`mime_type` text NOT NULL,
	`caption` text DEFAULT '' NOT NULL,
	`description` text,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `characters` ADD `include_gallery_in_prompt` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `characters` ADD `include_avatar_in_prompt` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `characters` ADD `avatar_description` text;--> statement-breakpoint
ALTER TABLE `personas` ADD `include_avatar_in_prompt` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `personas` ADD `avatar_description` text;