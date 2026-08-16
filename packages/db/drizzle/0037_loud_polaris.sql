CREATE TABLE `experience_copilot_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`tool_calls_json` text,
	`tool_call_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `experience_copilot_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_experience_copilot_messages_thread` ON `experience_copilot_messages` (`thread_id`);--> statement-breakpoint
CREATE TABLE `experience_copilot_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`script_id` text,
	`draft_session_id` text,
	`title` text DEFAULT '' NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_experience_copilot_threads_script` ON `experience_copilot_threads` (`script_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_experience_copilot_threads_active_script` ON `experience_copilot_threads` (`script_id`) WHERE "experience_copilot_threads"."archived_at" IS NULL AND "experience_copilot_threads"."script_id" IS NOT NULL;