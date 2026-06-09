PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chats` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`persona_id` text,
	`active_branch_id` text NOT NULL,
	`prompt_preset_id` text,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`message_history_limit` integer DEFAULT 0 NOT NULL,
	`auto_summary_config_json` text DEFAULT '{"enabled":false,"everyN":20,"useChatModel":true,"excludeSummarized":true}' NOT NULL,
	`last_accessed_at` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`selected_greeting_index` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`lore_activation_state_json` text DEFAULT '{}' NOT NULL,
	`script_state_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prompt_preset_id`) REFERENCES `prompt_presets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_chats`("id", "character_id", "persona_id", "active_branch_id", "prompt_preset_id", "title", "summary", "message_history_limit", "auto_summary_config_json", "last_accessed_at", "status", "selected_greeting_index", "created_at", "updated_at", "lore_activation_state_json", "script_state_json") SELECT "id", "character_id", "persona_id", "active_branch_id", "prompt_preset_id", "title", COALESCE("summary", ''), "message_history_limit", COALESCE("auto_summary_config_json", '{"enabled":false,"everyN":20,"useChatModel":true,"excludeSummarized":true}'), COALESCE("last_accessed_at", ''), COALESCE("status", 'active'), COALESCE("selected_greeting_index", 0), "created_at", "updated_at", COALESCE("lore_activation_state_json", '{}'), COALESCE("script_state_json", '{}') FROM `chats`;--> statement-breakpoint
DROP TABLE `chats`;--> statement-breakpoint
ALTER TABLE `__new_chats` RENAME TO `chats`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_chats_character_id` ON `chats` (`character_id`);--> statement-breakpoint
CREATE INDEX `idx_chats_last_accessed` ON `chats` (`last_accessed_at`);