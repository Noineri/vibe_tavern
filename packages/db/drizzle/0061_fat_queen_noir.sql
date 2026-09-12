CREATE TABLE `prompt_trace_chunk_refs` (
	`trace_id` text NOT NULL,
	`chunk_id` text NOT NULL,
	PRIMARY KEY(`trace_id`, `chunk_id`)
);
--> statement-breakpoint
CREATE TABLE `prompt_trace_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`byte_size` integer NOT NULL,
	`content` text NOT NULL
);
