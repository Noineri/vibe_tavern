CREATE TABLE `regex_links` (
	`regex_preset_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	PRIMARY KEY(`regex_preset_id`, `target_type`, `target_id`),
	FOREIGN KEY (`regex_preset_id`) REFERENCES `regex_presets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_regex_links_target` ON `regex_links` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_regex_links_preset` ON `regex_links` (`regex_preset_id`);--> statement-breakpoint
CREATE TABLE `regex_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`find_regex` text NOT NULL,
	`replace_string` text DEFAULT '' NOT NULL,
	`trim_strings_json` text DEFAULT '[]' NOT NULL,
	`substitute_regex` integer DEFAULT 0 NOT NULL,
	`disabled` integer DEFAULT 0 NOT NULL,
	`markdown_only` integer DEFAULT 0 NOT NULL,
	`prompt_only` integer DEFAULT 0 NOT NULL,
	`run_on_edit` integer DEFAULT 1 NOT NULL,
	`min_depth` integer,
	`max_depth` integer,
	`placement_json` text DEFAULT '[2]' NOT NULL,
	`is_global` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_regex_presets_global` ON `regex_presets` (`is_global`);