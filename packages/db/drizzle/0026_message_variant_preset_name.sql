-- Bake the per-variant preset as an immutable NAME string, dropping the
-- `preset_id` foreign key to prompt_presets (PRESET_COPY_DELETE_CORRUPTION
-- bug 2, root-cause fix).
--
-- `preset_id` (FK, ON DELETE SET NULL in current builds; NO ACTION in older
-- user DBs) was purely historical metadata — every reader resolved it to the
-- preset's display NAME, and no path used it functionally (regeneration reads
-- the live chat/input preset, never the variant's). Coupling message metadata
-- to the lifetime of a preset row caused two failure modes: deleting a preset
-- blocked on the FK (the reported SQLITE_CONSTRAINT_FOREIGNKEY — a stale
-- NO-ACTION FK in the reporter's DB) or silently nulled the historical record
-- (SET NULL). Storing the resolved NAME as plain text (no FK) survives preset
-- delete/rename and makes preset consistent with model_id (also a no-FK text
-- column). See `messageVariants.presetName` in db-schema.ts.
--
-- This migration is the auto-heal for affected users: the rebuild physically
-- replaces the table, so a stale NO-ACTION `preset_id` FK disappears with the
-- old table, and existing variants keep their preset name via the backfill.
--
-- Three phases (mirrors 0001_preset_default_flag.sql — the established rebuild
-- template; SQLite cannot drop an FK-bearing column in place, only via
-- create-copy-drop-rename):
--   1. ADD `preset_name` (nullable; historical rows without a resolvable preset
--      stay NULL — their history is genuinely lost, which is honest).
--   2. Backfill `preset_name` from the live preset rows via a correlated
--      subquery (LEFT JOIN semantics: orphaned preset_id → NULL).
--   3. Rebuild the table without `preset_id` (drops the FK too); the INSERT…
--      SELECT carries the now-populated `preset_name` across. Recreates the
--      unique (message_id, variant_index) index (DROP TABLE drops indexes).

-- Phase 1: add the column.
ALTER TABLE `message_variants` ADD `preset_name` text;
--> statement-breakpoint

-- Phase 2: backfill from the live preset rows. Correlated subquery = LEFT JOIN
-- semantics: a variant whose preset_id no longer matches any preset (already
-- orphaned before this migration) stays NULL — correct, since that history is
-- irrecoverable. Uses preset_id BEFORE phase 3 drops it.
UPDATE `message_variants`
SET `preset_name` = (SELECT `name` FROM `prompt_presets` WHERE `id` = `message_variants`.`preset_id`);
--> statement-breakpoint

-- Phase 3: rebuild without `preset_id`.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_message_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`variant_index` integer NOT NULL,
	`content` text NOT NULL,
	`is_selected` integer DEFAULT 0 NOT NULL,
	`finish_reason` text,
	`reasoning` text,
	`reasoning_duration_ms` integer,
	`model_id` text,
	`preset_name` text,
	`tool_calls_json` text,
	`tool_call_id` text,
	`coauthor_module_id` text,
	`coauthor_skill_id` text,
	`scene_tracker_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_message_variants`(`id`, `message_id`, `variant_index`, `content`, `is_selected`, `finish_reason`, `reasoning`, `reasoning_duration_ms`, `model_id`, `preset_name`, `tool_calls_json`, `tool_call_id`, `coauthor_module_id`, `coauthor_skill_id`, `scene_tracker_json`, `created_at`) SELECT `id`, `message_id`, `variant_index`, `content`, `is_selected`, `finish_reason`, `reasoning`, `reasoning_duration_ms`, `model_id`, `preset_name`, `tool_calls_json`, `tool_call_id`, `coauthor_module_id`, `coauthor_skill_id`, `scene_tracker_json`, `created_at` FROM `message_variants`;
--> statement-breakpoint
DROP TABLE `message_variants`;
--> statement-breakpoint
ALTER TABLE `__new_message_variants` RENAME TO `message_variants`;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_message_variants_unique` ON `message_variants` (`message_id`, `variant_index`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
