CREATE TABLE `fly_tribunal_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`reaction_tier` text DEFAULT 'indication' NOT NULL,
	`regen_cap` integer DEFAULT 2 NOT NULL,
	`sensitivity` text DEFAULT 'normal' NOT NULL,
	`auto_swipe_confidence` text DEFAULT 'high' NOT NULL,
	`training_enabled` integer DEFAULT true NOT NULL,
	`training_speed` text DEFAULT 'normal' NOT NULL,
	`precedent_lifetime_days` integer,
	`hints_json` text DEFAULT '[]' NOT NULL,
	`memory_scope` text DEFAULT 'chat' NOT NULL,
	`updated_at` text NOT NULL
);
