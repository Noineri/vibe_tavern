CREATE TABLE `image_gen_listing_snapshots` (
	`image_gen_profile_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`image_gen_profile_id`, `kind`),
	FOREIGN KEY (`image_gen_profile_id`) REFERENCES `image_gen_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
