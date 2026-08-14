ALTER TABLE `experience_chat_configs` ADD `context_source_character_id` text REFERENCES `characters`(`id`) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `experience_chat_configs` ADD `context_source_chat_id` text REFERENCES `chats`(`id`) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `experience_context_bundles` ADD `source_character_id` text;--> statement-breakpoint
ALTER TABLE `experience_context_bundles` ADD `source_chat_id` text;
