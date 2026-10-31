PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_prompt_trace_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`byte_size` integer NOT NULL,
	`content` blob NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_prompt_trace_chunks`("id", "byte_size", "content") SELECT "id", "byte_size", "content" FROM `prompt_trace_chunks`;--> statement-breakpoint
DROP TABLE `prompt_trace_chunks`;--> statement-breakpoint
ALTER TABLE `__new_prompt_trace_chunks` RENAME TO `prompt_trace_chunks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_prompt_traces` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`message_id` text NOT NULL,
	`model` text NOT NULL,
	`preset_name` text NOT NULL,
	`assembled_layers_json` blob NOT NULL,
	`token_accounting_json` text NOT NULL,
	`final_payload_json` blob DEFAULT '{}' NOT NULL,
	`activated_lore_entries_json` text DEFAULT '[]' NOT NULL,
	`activated_lore_detail_json` text,
	`overflowed_lorebooks_json` text DEFAULT '[]' NOT NULL,
	`retrieved_memories_json` text DEFAULT '[]' NOT NULL,
	`script_injections_json` text DEFAULT '[]' NOT NULL,
	`prefill` text,
	`compaction_summary` text,
	`latency_ms` integer NOT NULL,
	`sent_config_json` text,
	`provider_response_json` blob,
	`variant_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `chat_branches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `message_variants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_prompt_traces`("id", "chat_id", "branch_id", "message_id", "model", "preset_name", "assembled_layers_json", "token_accounting_json", "final_payload_json", "activated_lore_entries_json", "activated_lore_detail_json", "overflowed_lorebooks_json", "retrieved_memories_json", "script_injections_json", "prefill", "compaction_summary", "latency_ms", "sent_config_json", "provider_response_json", "variant_id", "created_at") SELECT "id", "chat_id", "branch_id", "message_id", "model", "preset_name", "assembled_layers_json", "token_accounting_json", "final_payload_json", "activated_lore_entries_json", "activated_lore_detail_json", "overflowed_lorebooks_json", "retrieved_memories_json", "script_injections_json", "prefill", "compaction_summary", "latency_ms", "sent_config_json", "provider_response_json", "variant_id", "created_at" FROM `prompt_traces`;--> statement-breakpoint
DROP TABLE `prompt_traces`;--> statement-breakpoint
ALTER TABLE `__new_prompt_traces` RENAME TO `prompt_traces`;--> statement-breakpoint
CREATE INDEX `idx_prompt_traces_chat_branch` ON `prompt_traces` (`chat_id`,`branch_id`,`created_at`);