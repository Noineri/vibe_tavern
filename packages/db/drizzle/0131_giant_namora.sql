PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_review_rounds` (
	`thread_id` text,
	`chat_id` text,
	`envelope_json` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `experience_copilot_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_review_rounds_one_owner" CHECK(("__new_agent_review_rounds"."thread_id" IS NOT NULL AND "__new_agent_review_rounds"."chat_id" IS NULL) OR ("__new_agent_review_rounds"."thread_id" IS NULL AND "__new_agent_review_rounds"."chat_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_agent_review_rounds`("thread_id", "chat_id", "envelope_json", "updated_at") SELECT "thread_id", NULL, "envelope_json", "updated_at" FROM `agent_review_rounds`;--> statement-breakpoint
DROP TABLE `agent_review_rounds`;--> statement-breakpoint
ALTER TABLE `__new_agent_review_rounds` RENAME TO `agent_review_rounds`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_review_rounds_thread_id_unique` ON `agent_review_rounds` (`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_review_rounds_chat_id_unique` ON `agent_review_rounds` (`chat_id`);
