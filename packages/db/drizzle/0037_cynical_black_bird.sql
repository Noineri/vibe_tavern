PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lorebooks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`scope_type` text NOT NULL,
	`scan_depth` integer DEFAULT 10 NOT NULL,
	`token_budget` integer DEFAULT 1000 NOT NULL,
	`recursive_scanning` integer DEFAULT 0 NOT NULL,
	`max_recursion_steps` integer DEFAULT 5 NOT NULL,
	`include_names` integer DEFAULT 0 NOT NULL,
	`min_activations` integer DEFAULT 0 NOT NULL,
	`min_activations_depth_max` integer DEFAULT 0 NOT NULL,
	`overflow_alert` integer DEFAULT 0 NOT NULL,
	`character_strategy` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`character_id` text,
	`persona_id` text,
	`chat_id` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`extensions_json` text DEFAULT '{}' NOT NULL,
	`content_hash` text,
	`has_file_on_disk` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_lorebooks`("id", "name", "description", "scope_type", "scan_depth", "token_budget", "recursive_scanning", "max_recursion_steps", "include_names", "min_activations", "min_activations_depth_max", "overflow_alert", "character_strategy", "sort_order", "character_id", "persona_id", "chat_id", "enabled", "extensions_json", "content_hash", "has_file_on_disk", "created_at", "updated_at") SELECT "id", "name", "description", "scope_type", "scan_depth", "token_budget", "recursive_scanning", "max_recursion_steps", "include_names", "min_activations", "min_activations_depth_max", "overflow_alert", "character_strategy", "sort_order", "character_id", "persona_id", "chat_id", "enabled", "extensions_json", "content_hash", "has_file_on_disk", "created_at", "updated_at" FROM `lorebooks`;--> statement-breakpoint
DROP TABLE `lorebooks`;--> statement-breakpoint
ALTER TABLE `__new_lorebooks` RENAME TO `lorebooks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_lorebooks_character` ON `lorebooks` (`character_id`);--> statement-breakpoint
CREATE INDEX `idx_lorebooks_persona` ON `lorebooks` (`persona_id`);--> statement-breakpoint
CREATE INDEX `idx_lorebooks_chat` ON `lorebooks` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_lorebooks_scope` ON `lorebooks` (`scope_type`);