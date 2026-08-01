PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_provider_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`provider_preset` text NOT NULL,
	`coauthor_transport` text DEFAULT 'chat_completions' NOT NULL,
	`endpoint` text NOT NULL,
	`api_key` text,
	`default_model` text,
	`context_budget` integer,
	`pin_context_budget` integer DEFAULT false NOT NULL,
	`bind_per_model` integer DEFAULT false NOT NULL,
	`model_free_only` integer DEFAULT false NOT NULL,
	`model_group_by_owner` integer DEFAULT false NOT NULL,
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
	`proxy_mode` text DEFAULT 'inherit' NOT NULL,
	`proxy_id` text,
	`vision_model` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`proxy_id`) REFERENCES `proxy_profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "provider_profiles_proxy_policy_check" CHECK(("__new_provider_profiles"."proxy_mode" = 'proxy' AND "__new_provider_profiles"."proxy_id" IS NOT NULL) OR ("__new_provider_profiles"."proxy_mode" IN ('inherit', 'direct') AND "__new_provider_profiles"."proxy_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_provider_profiles`("id", "name", "sort_order", "provider_preset", "coauthor_transport", "endpoint", "api_key", "default_model", "context_budget", "pin_context_budget", "bind_per_model", "model_free_only", "model_group_by_owner", "max_tokens", "temperature", "top_p", "top_k", "min_p", "top_a", "typical_p", "tfs_z", "repeat_last_n", "mirostat", "mirostat_tau", "mirostat_eta", "dry_multiplier", "dry_base", "dry_allowed_length", "dry_sequence_breakers_json", "xtc_threshold", "xtc_probability", "frequency_penalty", "presence_penalty", "repetition_penalty", "stop_sequences_json", "logit_bias_json", "seed", "reasoning_effort", "show_reasoning", "stream_response", "custom_samplers", "is_active", "proxy_mode", "proxy_id", "vision_model", "created_at", "updated_at") SELECT "id", "name", "sort_order", "provider_preset", "coauthor_transport", "endpoint", "api_key", "default_model", "context_budget", "pin_context_budget", "bind_per_model", "model_free_only", "model_group_by_owner", "max_tokens", "temperature", "top_p", "top_k", "min_p", "top_a", "typical_p", "tfs_z", "repeat_last_n", "mirostat", "mirostat_tau", "mirostat_eta", "dry_multiplier", "dry_base", "dry_allowed_length", "dry_sequence_breakers_json", "xtc_threshold", "xtc_probability", "frequency_penalty", "presence_penalty", "repetition_penalty", "stop_sequences_json", "logit_bias_json", "seed", "reasoning_effort", "show_reasoning", "stream_response", "custom_samplers", "is_active", "proxy_mode", "proxy_id", "vision_model", "created_at", "updated_at" FROM `provider_profiles`;--> statement-breakpoint
DROP TABLE `provider_profiles`;--> statement-breakpoint
ALTER TABLE `__new_provider_profiles` RENAME TO `provider_profiles`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_proxy_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`default_proxy_id` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`default_proxy_id`) REFERENCES `proxy_profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "proxy_settings_singleton_id_check" CHECK("__new_proxy_settings"."id" = 'default')
);
--> statement-breakpoint
INSERT INTO `__new_proxy_settings`("id", "default_proxy_id", "updated_at") SELECT "id", "default_proxy_id", "updated_at" FROM `proxy_settings`;--> statement-breakpoint
DROP TABLE `proxy_settings`;--> statement-breakpoint
ALTER TABLE `__new_proxy_settings` RENAME TO `proxy_settings`;