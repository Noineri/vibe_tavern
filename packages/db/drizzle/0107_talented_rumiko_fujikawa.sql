PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- 0107 (LORE_SCRIPT_OWNERS_AS_LINKS step 1): every character/persona owner
-- becomes a plain link. BEFORE the tables are rebuilt without the home
-- columns, copy every ENTITY-scoped home into its link table. Entity-only on
-- purpose: the chat resolvers fired the home FK only for scope_type='entity'
-- (lorebook-chat-resolution.ts / ScriptStore.resolveChatScriptBindings), so a
-- stale home on a global/chat row never granted participation — copying it
-- would CREATE participation that never existed. OR IGNORE deduplicates
-- against links that already exist (composite PK lorebook/script + type + id).
INSERT OR IGNORE INTO `lorebook_links` (`lorebook_id`, `target_type`, `target_id`)
  SELECT `id`, 'character', `character_id` FROM `lorebooks`
  WHERE `scope_type` = 'entity' AND `character_id` IS NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `lorebook_links` (`lorebook_id`, `target_type`, `target_id`)
  SELECT `id`, 'persona', `persona_id` FROM `lorebooks`
  WHERE `scope_type` = 'entity' AND `persona_id` IS NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `script_links` (`script_id`, `target_type`, `target_id`)
  SELECT `id`, 'character', `character_id` FROM `scripts`
  WHERE `scope_type` = 'entity' AND `character_id` IS NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `script_links` (`script_id`, `target_type`, `target_id`)
  SELECT `id`, 'persona', `persona_id` FROM `scripts`
  WHERE `scope_type` = 'entity' AND `persona_id` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_lorebooks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`scope_type` text NOT NULL,
	`scan_depth` integer DEFAULT 10 NOT NULL,
	`token_budget` integer DEFAULT 1000 NOT NULL,
	`token_budget_percent` integer,
	`token_budget_cap` integer DEFAULT 0 NOT NULL,
	`recursive_scanning` integer DEFAULT 0 NOT NULL,
	`use_group_scoring` integer DEFAULT 0 NOT NULL,
	`case_sensitive` integer DEFAULT 0 NOT NULL,
	`match_whole_words` integer DEFAULT 0 NOT NULL,
	`max_recursion_steps` integer DEFAULT 0 NOT NULL,
	`include_names` integer DEFAULT 1 NOT NULL,
	`min_activations` integer DEFAULT 0 NOT NULL,
	`min_activations_depth_max` integer DEFAULT 0 NOT NULL,
	`overflow_alert` integer DEFAULT 0 NOT NULL,
	`character_strategy` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`chat_id` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`extensions_json` text DEFAULT '{}' NOT NULL,
	`content_hash` text,
	`has_file_on_disk` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_lorebooks`("id", "name", "description", "scope_type", "scan_depth", "token_budget", "token_budget_percent", "token_budget_cap", "recursive_scanning", "use_group_scoring", "case_sensitive", "match_whole_words", "max_recursion_steps", "include_names", "min_activations", "min_activations_depth_max", "overflow_alert", "character_strategy", "sort_order", "chat_id", "enabled", "extensions_json", "content_hash", "has_file_on_disk", "created_at", "updated_at") SELECT "id", "name", "description", "scope_type", "scan_depth", "token_budget", "token_budget_percent", "token_budget_cap", "recursive_scanning", "use_group_scoring", "case_sensitive", "match_whole_words", "max_recursion_steps", "include_names", "min_activations", "min_activations_depth_max", "overflow_alert", "character_strategy", "sort_order", "chat_id", "enabled", "extensions_json", "content_hash", "has_file_on_disk", "created_at", "updated_at" FROM `lorebooks`;--> statement-breakpoint
DROP TABLE `lorebooks`;--> statement-breakpoint
ALTER TABLE `__new_lorebooks` RENAME TO `lorebooks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_lorebooks_chat` ON `lorebooks` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_lorebooks_scope` ON `lorebooks` (`scope_type`);--> statement-breakpoint
CREATE TABLE `__new_scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`code` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`script_kind` text DEFAULT 'prompt' NOT NULL,
	`creation_intent_id` text,
	`scope_type` text DEFAULT 'character' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`chat_id` text,
	`default_visual_id` text,
	`copilot_profile_id` text,
	`extensions_json` text DEFAULT '{}' NOT NULL,
	`content_hash` text,
	`has_file_on_disk` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_scripts`("id", "name", "description", "code", "enabled", "script_kind", "creation_intent_id", "scope_type", "sort_order", "chat_id", "default_visual_id", "copilot_profile_id", "extensions_json", "content_hash", "has_file_on_disk", "created_at", "updated_at") SELECT "id", "name", "description", "code", "enabled", "script_kind", "creation_intent_id", "scope_type", "sort_order", "chat_id", "default_visual_id", "copilot_profile_id", "extensions_json", "content_hash", "has_file_on_disk", "created_at", "updated_at" FROM `scripts`;--> statement-breakpoint
DROP TABLE `scripts`;--> statement-breakpoint
ALTER TABLE `__new_scripts` RENAME TO `scripts`;--> statement-breakpoint
CREATE UNIQUE INDEX `scripts_creation_intent_id_unique` ON `scripts` (`creation_intent_id`);--> statement-breakpoint
CREATE INDEX `idx_scripts_chat` ON `scripts` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_scripts_scope` ON `scripts` (`scope_type`);--> statement-breakpoint
CREATE INDEX `idx_scripts_kind` ON `scripts` (`script_kind`);