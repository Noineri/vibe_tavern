CREATE TABLE `script_links` (
	`script_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	PRIMARY KEY(`script_id`, `target_type`, `target_id`),
	FOREIGN KEY (`script_id`) REFERENCES `scripts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_script_links_target` ON `script_links` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_script_links_script` ON `script_links` (`script_id`);