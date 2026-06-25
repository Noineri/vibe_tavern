CREATE TABLE `character_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`title` text NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_character_versions_character_id` ON `character_versions` (`character_id`);