CREATE TABLE `coauthor_modules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`base_prompt` text NOT NULL,
	`opening_message` text DEFAULT '' NOT NULL,
	`skill_ids_json` text DEFAULT '[]' NOT NULL,
	`tool_set_json` text DEFAULT '{}' NOT NULL,
	`max_steps` integer DEFAULT 5 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
