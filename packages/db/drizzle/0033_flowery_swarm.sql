ALTER TABLE `ui_settings` ADD `github_starred` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `ui_settings` ADD `user_message_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ui_settings` ADD `next_star_prompt_at` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `ui_settings` ADD `star_prompt_deferrals` integer DEFAULT 0 NOT NULL;