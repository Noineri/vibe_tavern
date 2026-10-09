CREATE TABLE `script_safety_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`suppress_import_warnings` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "script_safety_settings_singleton_id_check" CHECK("script_safety_settings"."id" = 'default')
);
--> statement-breakpoint
ALTER TABLE `scripts` ADD `origin` text DEFAULT 'in_app' NOT NULL;--> statement-breakpoint
ALTER TABLE `scripts` ADD `first_enabled_at` text;