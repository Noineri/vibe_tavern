CREATE TABLE `image_gen_prompt_caps` (
	`backend` text NOT NULL,
	`model_id` text NOT NULL,
	`max_prompt_chars` integer NOT NULL,
	`learned_at` text NOT NULL,
	PRIMARY KEY(`backend`, `model_id`)
);
