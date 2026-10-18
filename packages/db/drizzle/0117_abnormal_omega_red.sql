CREATE TABLE `chat_agent_settings` (
	`chat_id` text NOT NULL,
	`agent_kind` text NOT NULL,
	`profile_id` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`chat_id`, `agent_kind`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
