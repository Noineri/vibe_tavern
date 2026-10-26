CREATE TABLE `agent_thread_context_events` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`seq` integer,
	`kind` text NOT NULL,
	`payload_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `experience_copilot_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_thread_context_events_thread` ON `agent_thread_context_events` (`thread_id`);--> statement-breakpoint
ALTER TABLE `experience_copilot_messages` ADD `seq` integer;--> statement-breakpoint
ALTER TABLE `experience_copilot_threads` ADD `next_seq` integer;--> statement-breakpoint
ALTER TABLE `experience_copilot_threads` ADD `rp_frontier_json` text;