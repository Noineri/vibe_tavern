ALTER TABLE `chats` ADD `mode` text DEFAULT 'rp' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_chats_mode` ON `chats` (`mode`);