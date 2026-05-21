CREATE TABLE `lore_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`lorebook_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`keys_json` text DEFAULT '[]' NOT NULL,
	`secondary_keys_json` text DEFAULT '[]' NOT NULL,
	`logic` text DEFAULT 'and_any' NOT NULL,
	`position` text DEFAULT 'in_prompt' NOT NULL,
	`depth` integer DEFAULT 4 NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`sticky_window` integer DEFAULT 0 NOT NULL,
	`cooldown_window` integer DEFAULT 0 NOT NULL,
	`delay_window` integer DEFAULT 0 NOT NULL,
	`constant` integer DEFAULT 0 NOT NULL,
	`probability` integer DEFAULT 100 NOT NULL,
	`role` text DEFAULT 'system' NOT NULL,
	`group_name` text DEFAULT '' NOT NULL,
	`group_weight` integer DEFAULT 100 NOT NULL,
	`prioritize_inclusion` integer DEFAULT 0 NOT NULL,
	`exclude_recursion` integer DEFAULT 0 NOT NULL,
	`prevent_recursion` integer DEFAULT 0 NOT NULL,
	`delay_until_recursion` integer DEFAULT 0 NOT NULL,
	`recursion_level` integer DEFAULT 0 NOT NULL,
	`scan_depth_override` integer,
	`case_sensitive` integer DEFAULT 0 NOT NULL,
	`match_whole_words` integer DEFAULT 0 NOT NULL,
	`character_filter_json` text DEFAULT '[]' NOT NULL,
	`character_filter_exclude` integer DEFAULT 0 NOT NULL,
	`triggers_json` text DEFAULT '[]' NOT NULL,
	`match_sources_json` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`lorebook_id`) REFERENCES `lorebooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_lore_entries_lorebook` ON `lore_entries` (`lorebook_id`);--> statement-breakpoint
CREATE TABLE `lorebooks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`scope_type` text NOT NULL,
	`scan_depth` integer DEFAULT 50 NOT NULL,
	`token_budget` integer DEFAULT 1000 NOT NULL,
	`recursive_scanning` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`character_id` text,
	`persona_id` text,
	`chat_id` text,
	`extensions_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_lorebooks_character` ON `lorebooks` (`character_id`);--> statement-breakpoint
CREATE INDEX `idx_lorebooks_persona` ON `lorebooks` (`persona_id`);--> statement-breakpoint
CREATE INDEX `idx_lorebooks_chat` ON `lorebooks` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_lorebooks_scope` ON `lorebooks` (`scope_type`);--> statement-breakpoint
CREATE TABLE `scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`code` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`scope_type` text DEFAULT 'character' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`character_id` text,
	`persona_id` text,
	`chat_id` text,
	`extensions_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_scripts_character` ON `scripts` (`character_id`);--> statement-breakpoint
CREATE INDEX `idx_scripts_persona` ON `scripts` (`persona_id`);--> statement-breakpoint
CREATE INDEX `idx_scripts_chat` ON `scripts` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_scripts_scope` ON `scripts` (`scope_type`);--> statement-breakpoint
ALTER TABLE `chats` ADD `lore_activation_state_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `script_state_json` text DEFAULT '{}' NOT NULL;