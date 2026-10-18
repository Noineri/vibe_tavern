CREATE TABLE `agent_kind_settings` (
	`agent_kind` text PRIMARY KEY NOT NULL,
	`provider_profile_id` text,
	`model_name` text,
	`default_profile_id` text,
	`updated_at` text NOT NULL
);
