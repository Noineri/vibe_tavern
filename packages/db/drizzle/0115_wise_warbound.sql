ALTER TABLE `experience_copilot_threads` ADD `chat_id` text REFERENCES `chats`(`id`) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `experience_copilot_threads` ADD `branch_id` text REFERENCES `chat_branches`(`id`) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `experience_copilot_threads` ADD `agent_kind` text;--> statement-breakpoint
CREATE INDEX `idx_experience_copilot_threads_chat_branch` ON `experience_copilot_threads` (`chat_id`,`branch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_experience_copilot_threads_active_chat` ON `experience_copilot_threads` (`chat_id`,`branch_id`,`agent_kind`) WHERE "experience_copilot_threads"."archived_at" IS NULL AND "experience_copilot_threads"."chat_id" IS NOT NULL;