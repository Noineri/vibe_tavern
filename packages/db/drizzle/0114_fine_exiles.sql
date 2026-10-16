CREATE TABLE `stt_listing_snapshots` (
	`stt_profile_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`stt_profile_id`, `kind`),
	FOREIGN KEY (`stt_profile_id`) REFERENCES `stt_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tts_listing_snapshots` (
	`tts_profile_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`tts_profile_id`, `kind`),
	FOREIGN KEY (`tts_profile_id`) REFERENCES `tts_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
