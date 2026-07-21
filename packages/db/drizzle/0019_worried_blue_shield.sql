CREATE TABLE `dice_pending_lanes` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`mode` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `chat_branches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dice_lanes_chat_branch_mode` ON `dice_pending_lanes` (`chat_id`,`branch_id`,`mode`);--> statement-breakpoint
CREATE TABLE `dice_rolls` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`lane_id` text NOT NULL,
	`bound_message_id` text,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_label` text NOT NULL,
	`script_id` text NOT NULL,
	`script_label` text NOT NULL,
	`script_revision` integer NOT NULL,
	`check_id` text NOT NULL,
	`check_label` text NOT NULL,
	`notation` text NOT NULL,
	`face_shape` text NOT NULL,
	`resolution` text NOT NULL,
	`mode` text NOT NULL,
	`included` integer DEFAULT true NOT NULL,
	`final_attempt_id` text,
	`attempts_json` text NOT NULL,
	`final_json` text,
	`retry_reason` text,
	`policy` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`lane_id`) REFERENCES `dice_pending_lanes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bound_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dice_rolls_request_id_unique` ON `dice_rolls` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_dice_rolls_lane` ON `dice_rolls` (`lane_id`);--> statement-breakpoint
CREATE INDEX `idx_dice_rolls_message` ON `dice_rolls` (`bound_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dice_rolls_request` ON `dice_rolls` (`request_id`);