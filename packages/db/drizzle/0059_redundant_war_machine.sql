PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lore_entries` (
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
	`ignore_budget` integer DEFAULT 0 NOT NULL,
	`role` text DEFAULT 'system' NOT NULL,
	`group_name` text DEFAULT '' NOT NULL,
	`group_weight` integer DEFAULT 100 NOT NULL,
	`prioritize_inclusion` integer DEFAULT 0 NOT NULL,
	`use_group_scoring` integer,
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
	`automation_id` text DEFAULT '' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`content_hash` text,
	`has_file_on_disk` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`lorebook_id`) REFERENCES `lorebooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_lore_entries`("id", "lorebook_id", "title", "content", "keys_json", "secondary_keys_json", "logic", "position", "depth", "priority", "sticky_window", "cooldown_window", "delay_window", "constant", "probability", "ignore_budget", "role", "group_name", "group_weight", "prioritize_inclusion", "use_group_scoring", "exclude_recursion", "prevent_recursion", "delay_until_recursion", "recursion_level", "scan_depth_override", "case_sensitive", "match_whole_words", "character_filter_json", "character_filter_exclude", "triggers_json", "match_sources_json", "enabled", "sort_order", "automation_id", "metadata_json", "content_hash", "has_file_on_disk", "created_at", "updated_at") SELECT "id", "lorebook_id", "title", "content", "keys_json", "secondary_keys_json", "logic", "position", "depth", "priority", "sticky_window", "cooldown_window", "delay_window", "constant", "probability", "ignore_budget", "role", "group_name", "group_weight", "prioritize_inclusion", "use_group_scoring", "exclude_recursion", "prevent_recursion", "delay_until_recursion", "recursion_level", "scan_depth_override", "case_sensitive", "match_whole_words", "character_filter_json", "character_filter_exclude", "triggers_json", "match_sources_json", "enabled", "sort_order", "automation_id", "metadata_json", "content_hash", "has_file_on_disk", "created_at", "updated_at" FROM `lore_entries`;--> statement-breakpoint
DROP TABLE `lore_entries`;--> statement-breakpoint
ALTER TABLE `__new_lore_entries` RENAME TO `lore_entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_lore_entries_lorebook` ON `lore_entries` (`lorebook_id`);--> statement-breakpoint
--> Data migration (LG-4): legacy rows carry 0/1 from the old NOT NULL boolean.
--> 0 was the never-touched default (no explicit "off" checkbox existed with
--> inherit semantics), so it maps to NULL = inherit the book-level default,
--> matching ST's tri-state entry flag. 1 stays 1 (explicitly scoring).
UPDATE `lore_entries` SET `use_group_scoring` = NULL WHERE `use_group_scoring` = 0;