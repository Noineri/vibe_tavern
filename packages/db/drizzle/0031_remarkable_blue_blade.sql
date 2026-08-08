CREATE TABLE `provider_quota_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`provider_profile_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`provider_profile_id`) REFERENCES `provider_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_provider_quota_events_profile` ON `provider_quota_events` (`provider_profile_id`);--> statement-breakpoint
CREATE TABLE `provider_quota_settings` (
	`provider_profile_id` text PRIMARY KEY NOT NULL,
	`config_kind` text NOT NULL,
	`display_enabled` integer DEFAULT false NOT NULL,
	`low_quota_enabled` integer,
	`low_quota_remaining_percent` integer,
	`reset_notify_enabled` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`provider_profile_id`) REFERENCES `provider_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `provider_quota_snapshots` (
	`provider_profile_id` text PRIMARY KEY NOT NULL,
	`snapshot_json` text,
	`transition_state_json` text,
	`last_error` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`provider_profile_id`) REFERENCES `provider_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
