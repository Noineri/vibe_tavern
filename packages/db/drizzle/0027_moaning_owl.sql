PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_provider_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider_preset` text NOT NULL,
	`endpoint` text NOT NULL,
	`api_key` text,
	`default_model` text,
	`context_budget` integer,
	`pin_context_budget` integer DEFAULT false NOT NULL,
	`max_tokens` integer DEFAULT 2000 NOT NULL,
	`temperature` real DEFAULT 1 NOT NULL,
	`top_p` real DEFAULT 1 NOT NULL,
	`top_k` integer DEFAULT 0 NOT NULL,
	`min_p` real DEFAULT 0 NOT NULL,
	`top_a` real DEFAULT 0 NOT NULL,
	`typical_p` real DEFAULT 1 NOT NULL,
	`tfs_z` real DEFAULT 1 NOT NULL,
	`repeat_last_n` integer DEFAULT 0 NOT NULL,
	`mirostat` integer DEFAULT 0 NOT NULL,
	`mirostat_tau` real DEFAULT 5 NOT NULL,
	`mirostat_eta` real DEFAULT 0.1 NOT NULL,
	`dry_multiplier` real DEFAULT 0 NOT NULL,
	`dry_base` real DEFAULT 1.75 NOT NULL,
	`dry_allowed_length` integer DEFAULT 2 NOT NULL,
	`dry_sequence_breakers_json` text,
	`xtc_threshold` real DEFAULT 0.1 NOT NULL,
	`xtc_probability` real DEFAULT 0 NOT NULL,
	`frequency_penalty` real DEFAULT 0 NOT NULL,
	`presence_penalty` real DEFAULT 0 NOT NULL,
	`repetition_penalty` real DEFAULT 1 NOT NULL,
	`stop_sequences_json` text,
	`logit_bias_json` text,
	`seed` text,
	`reasoning_effort` text DEFAULT 'auto' NOT NULL,
	`show_reasoning` integer DEFAULT 0 NOT NULL,
	`stream_response` integer DEFAULT 1 NOT NULL,
	`custom_samplers` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_provider_profiles`("id", "name", "provider_preset", "endpoint", "api_key", "default_model", "context_budget", "pin_context_budget", "max_tokens", "temperature", "top_p", "top_k", "min_p", "top_a", "typical_p", "tfs_z", "repeat_last_n", "mirostat", "mirostat_tau", "mirostat_eta", "dry_multiplier", "dry_base", "dry_allowed_length", "dry_sequence_breakers_json", "xtc_threshold", "xtc_probability", "frequency_penalty", "presence_penalty", "repetition_penalty", "stop_sequences_json", "logit_bias_json", "seed", "reasoning_effort", "show_reasoning", "stream_response", "custom_samplers", "is_active", "created_at", "updated_at") SELECT "id", "name", "provider_preset", "endpoint", "api_key", "default_model", "context_budget", "pin_context_budget", "max_tokens", "temperature", "top_p", "top_k", "min_p", "top_a", "typical_p", "tfs_z", "repeat_last_n", "mirostat", "mirostat_tau", "mirostat_eta", "dry_multiplier", "dry_base", "dry_allowed_length", "dry_sequence_breakers_json", "xtc_threshold", "xtc_probability", "frequency_penalty", "presence_penalty", "repetition_penalty", "stop_sequences_json", "logit_bias_json", "seed", "reasoning_effort", "show_reasoning", "stream_response", "custom_samplers", "is_active", "created_at", "updated_at" FROM `provider_profiles`;--> statement-breakpoint
DROP TABLE `provider_profiles`;--> statement-breakpoint
ALTER TABLE `__new_provider_profiles` RENAME TO `provider_profiles`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `characters` ADD `avatar_crop_json` text;--> statement-breakpoint
ALTER TABLE `personas` ADD `avatar_crop_json` text;