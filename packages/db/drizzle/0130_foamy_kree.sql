CREATE TABLE `agent_review_rounds` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`envelope_json` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `experience_copilot_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
