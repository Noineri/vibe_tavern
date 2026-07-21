ALTER TABLE `scripts` ADD `script_kind` text DEFAULT 'prompt' NOT NULL;--> statement-breakpoint
ALTER TABLE `scripts` ADD `creation_intent_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `scripts_creation_intent_id_unique` ON `scripts` (`creation_intent_id`);--> statement-breakpoint
CREATE INDEX `idx_scripts_kind` ON `scripts` (`script_kind`);