CREATE TABLE `agent_profile_models` (
	`agent_kind` text NOT NULL,
	`profile_id` text NOT NULL,
	`provider_profile_id` text NOT NULL,
	`model_name` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`agent_kind`, `profile_id`)
);
