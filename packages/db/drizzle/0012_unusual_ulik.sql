CREATE TABLE `scene_backfill_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`mode` text DEFAULT 'fill-missing' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`manifest_json` text DEFAULT '[]' NOT NULL,
	`total_items` integer DEFAULT 0 NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`errors_json` text DEFAULT '[]' NOT NULL,
	`cancel_requested` integer DEFAULT 0 NOT NULL,
	`summary_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_scene_backfill_runs_chat` ON `scene_backfill_runs` (`chat_id`);--> statement-breakpoint
ALTER TABLE `message_variants` ADD `scene_tracker_json` text;