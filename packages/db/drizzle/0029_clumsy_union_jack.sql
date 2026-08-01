CREATE TABLE `proxy_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`username` text,
	`password` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `proxy_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`default_proxy_id` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `proxy_mode` text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `proxy_id` text;