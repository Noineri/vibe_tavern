CREATE TABLE `token_counts` (
	`text_hash` text NOT NULL,
	`tokenizer` text NOT NULL,
	`token_count` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`text_hash`, `tokenizer`)
);
