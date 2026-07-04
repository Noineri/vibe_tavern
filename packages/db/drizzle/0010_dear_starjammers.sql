DROP INDEX `idx_chats_last_accessed`;--> statement-breakpoint
ALTER TABLE `chats` DROP COLUMN `last_accessed_at`;