CREATE TABLE `copilot_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_prompt` text NOT NULL,
	`skill_ids_json` text DEFAULT '[]' NOT NULL,
	`tool_set_json` text DEFAULT '{}' NOT NULL,
	`max_steps` integer DEFAULT 20 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `scripts` ADD `copilot_profile_id` text;