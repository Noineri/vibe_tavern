CREATE TABLE `chat_generation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`model` text NOT NULL,
	`prompt_preset_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`variant_index` integer,
	`error` text,
	`enqueued_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chat_generation_jobs_status" CHECK("chat_generation_jobs"."status" IN ('pending', 'running', 'done', 'failed', 'cancelled')),
	CONSTRAINT "chat_generation_jobs_variant_index" CHECK("chat_generation_jobs"."variant_index" IS NULL OR "chat_generation_jobs"."variant_index" >= 0),
	CONSTRAINT "chat_generation_jobs_enqueued_at" CHECK("chat_generation_jobs"."enqueued_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_chat_generation_jobs_chat_status_enqueued` ON `chat_generation_jobs` (`chat_id`,`status`,`enqueued_at`);