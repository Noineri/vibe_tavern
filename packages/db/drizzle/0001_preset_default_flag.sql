-- Replace the dead `bind_provider_preset_id` model-binding column with an
-- explicit `is_default` designated-default marker.
--
-- This migration runs in three phases:
--   1. ADD `is_default` (all existing rows default to 0).
--   2. Backfill exactly one row as the default (rowid-ascending order — see
--      comment below).
--   3. Rebuild the table without `bind_provider_preset_id` (SQLite has no
--      lightweight DROP COLUMN in all supported versions, so drizzle emits a
--      create-copy-drop-rename). The backfilled `is_default = 1` is carried
--      through by the INSERT ... SELECT.

-- Phase 1: add the column.
ALTER TABLE `prompt_presets` ADD `is_default` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- Phase 2: backfill the default. Rowid-ascending order is deliberate:
-- PresetStore.ensureDefault() resolves the default via `select().get()`
-- (= first row by rowid), so this preserves the current default-selection
-- byte-for-byte. Do NOT use `bind_provider_preset_id IS NULL` as a
-- discriminator — that column is fully dead (0 non-null values across every
-- DB and backup), so the filter would match every row and rely on LIMIT 1 by
-- accident. `created_at` only coincidentally agrees with rowid for the seeded
-- Default; rowid is the source of truth.
UPDATE `prompt_presets`
SET `is_default` = 1
WHERE `id` = (SELECT `id` FROM `prompt_presets` ORDER BY `rowid` ASC LIMIT 1);
--> statement-breakpoint

-- Phase 3: rebuild without `bind_provider_preset_id`.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_prompt_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`system_prompt` text DEFAULT '' NOT NULL,
	`post_history_instructions` text DEFAULT '' NOT NULL,
	`assistant_prefix` text DEFAULT '' NOT NULL,
	`authors_note` text DEFAULT '' NOT NULL,
	`authors_note_depth` integer DEFAULT 4 NOT NULL,
	`authors_note_position` text DEFAULT 'in_chat' NOT NULL,
	`authors_note_role` text DEFAULT 'system' NOT NULL,
	`summary_prompt` text DEFAULT '' NOT NULL,
	`tools_prompt` text DEFAULT '' NOT NULL,
	`nsfw_prompt` text DEFAULT '' NOT NULL,
	`enhance_definitions_prompt` text DEFAULT '' NOT NULL,
	`script_ai_system_prompt` text DEFAULT '' NOT NULL,
	`ai_assistant_prompts` text DEFAULT '{}' NOT NULL,
	`custom_injections_json` text DEFAULT '[]' NOT NULL,
	`prompt_order_json` text DEFAULT '[]' NOT NULL,
	`advanced_mode` integer DEFAULT 0 NOT NULL,
	`content_hash` text,
	`has_file_on_disk` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_prompt_presets`(`id`, `name`, `is_default`, `system_prompt`, `post_history_instructions`, `assistant_prefix`, `authors_note`, `authors_note_depth`, `authors_note_position`, `authors_note_role`, `summary_prompt`, `tools_prompt`, `nsfw_prompt`, `enhance_definitions_prompt`, `script_ai_system_prompt`, `ai_assistant_prompts`, `custom_injections_json`, `prompt_order_json`, `advanced_mode`, `content_hash`, `has_file_on_disk`, `created_at`, `updated_at`) SELECT `id`, `name`, `is_default`, `system_prompt`, `post_history_instructions`, `assistant_prefix`, `authors_note`, `authors_note_depth`, `authors_note_position`, `authors_note_role`, `summary_prompt`, `tools_prompt`, `nsfw_prompt`, `enhance_definitions_prompt`, `script_ai_system_prompt`, `ai_assistant_prompts`, `custom_injections_json`, `prompt_order_json`, `advanced_mode`, `content_hash`, `has_file_on_disk`, `created_at`, `updated_at` FROM `prompt_presets`;
--> statement-breakpoint
DROP TABLE `prompt_presets`;
--> statement-breakpoint
ALTER TABLE `__new_prompt_presets` RENAME TO `prompt_presets`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
