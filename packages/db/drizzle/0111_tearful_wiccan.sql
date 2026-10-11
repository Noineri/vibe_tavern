CREATE TABLE `agent_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`script_id` text NOT NULL,
	`content_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_plans_script` ON `agent_plans` (`script_id`);