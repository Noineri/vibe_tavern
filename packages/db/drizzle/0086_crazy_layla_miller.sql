CREATE TABLE `fly_tribunal_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text,
	`weights` blob,
	`precedent_count` integer DEFAULT 0 NOT NULL,
	`schema_version` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "fly_tribunal_memory_precedent_count_nonnegative" CHECK("fly_tribunal_memory"."precedent_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fly_tribunal_memory_chat_id` ON `fly_tribunal_memory` (`chat_id`);