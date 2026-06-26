CREATE TABLE `cached_models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_profile_id` text NOT NULL,
	`model_slug` text NOT NULL,
	`model_name` text NOT NULL,
	`context_length` integer,
	`capabilities_json` text DEFAULT '{}' NOT NULL,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`provider_profile_id`) REFERENCES `provider_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cached_models_provider_slug` ON `cached_models` (`provider_profile_id`,`model_slug`);--> statement-breakpoint
CREATE TABLE `character_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`ext` text NOT NULL,
	`mime_type` text NOT NULL,
	`caption` text DEFAULT '' NOT NULL,
	`description` text,
	`include_in_prompt` integer DEFAULT false NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`avatar_crop_json` text,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `character_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`title` text NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_character_versions_character_id` ON `character_versions` (`character_id`);--> statement-breakpoint
CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`personality_summary` text,
	`default_scenario` text,
	`first_message` text,
	`mes_example` text,
	`alternate_greetings_json` text DEFAULT '[]' NOT NULL,
	`post_history_instructions` text,
	`creator_notes` text,
	`character_book_json` text,
	`depth_prompt` text,
	`depth_prompt_depth` integer,
	`depth_prompt_role` text,
	`extensions_json` text DEFAULT '{}' NOT NULL,
	`system_prompt` text,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`avatar_asset_id` text,
	`avatar_full_asset_id` text,
	`avatar_crop_json` text,
	`avatar_ext` text,
	`avatar_full_ext` text,
	`avatar_source_asset_id` text,
	`include_gallery_in_prompt` integer DEFAULT false NOT NULL,
	`include_avatar_in_prompt` integer DEFAULT false NOT NULL,
	`avatar_description` text,
	`mes_example_mode` text DEFAULT 'always' NOT NULL,
	`mes_example_depth` integer DEFAULT 4 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`content_hash` text,
	`has_file_on_disk` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_branches` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`parent_branch_id` text,
	`forked_from_message_id` text,
	`label` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chat_branches_chat_id` ON `chat_branches` (`chat_id`);--> statement-breakpoint
CREATE TABLE `chat_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`summarized_from` integer DEFAULT 1 NOT NULL,
	`summarized_to` integer DEFAULT 0 NOT NULL,
	`include_in_context` integer DEFAULT 1 NOT NULL,
	`exclude_summarized` integer DEFAULT 1 NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`content_hash` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `chat_branches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chat_summaries_chat_branch` ON `chat_summaries` (`chat_id`,`branch_id`);--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL,
	`persona_id` text,
	`active_branch_id` text NOT NULL,
	`prompt_preset_id` text,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`message_history_limit` integer DEFAULT 0 NOT NULL,
	`auto_summary_config_json` text DEFAULT '{"enabled":false,"everyN":20,"useChatModel":true,"excludeSummarized":true}' NOT NULL,
	`last_accessed_at` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`selected_greeting_index` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`lore_activation_state_json` text DEFAULT '{}' NOT NULL,
	`script_state_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`prompt_preset_id`) REFERENCES `prompt_presets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_chats_character_id` ON `chats` (`character_id`);--> statement-breakpoint
CREATE INDEX `idx_chats_last_accessed` ON `chats` (`last_accessed_at`);--> statement-breakpoint
CREATE TABLE `lore_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`lorebook_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`keys_json` text DEFAULT '[]' NOT NULL,
	`secondary_keys_json` text DEFAULT '[]' NOT NULL,
	`logic` text DEFAULT 'and_any' NOT NULL,
	`position` text DEFAULT 'in_prompt' NOT NULL,
	`depth` integer DEFAULT 4 NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`sticky_window` integer DEFAULT 0 NOT NULL,
	`cooldown_window` integer DEFAULT 0 NOT NULL,
	`delay_window` integer DEFAULT 0 NOT NULL,
	`constant` integer DEFAULT 0 NOT NULL,
	`probability` integer DEFAULT 100 NOT NULL,
	`ignore_budget` integer DEFAULT 0 NOT NULL,
	`role` text DEFAULT 'system' NOT NULL,
	`group_name` text DEFAULT '' NOT NULL,
	`group_weight` integer DEFAULT 100 NOT NULL,
	`prioritize_inclusion` integer DEFAULT 0 NOT NULL,
	`use_group_scoring` integer DEFAULT 0 NOT NULL,
	`exclude_recursion` integer DEFAULT 0 NOT NULL,
	`prevent_recursion` integer DEFAULT 0 NOT NULL,
	`delay_until_recursion` integer DEFAULT 0 NOT NULL,
	`recursion_level` integer DEFAULT 0 NOT NULL,
	`scan_depth_override` integer,
	`case_sensitive` integer DEFAULT 0 NOT NULL,
	`match_whole_words` integer DEFAULT 0 NOT NULL,
	`character_filter_json` text DEFAULT '[]' NOT NULL,
	`character_filter_exclude` integer DEFAULT 0 NOT NULL,
	`triggers_json` text DEFAULT '[]' NOT NULL,
	`match_sources_json` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`automation_id` text DEFAULT '' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`content_hash` text,
	`has_file_on_disk` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`lorebook_id`) REFERENCES `lorebooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_lore_entries_lorebook` ON `lore_entries` (`lorebook_id`);--> statement-breakpoint
CREATE TABLE `lorebook_links` (
	`lorebook_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	PRIMARY KEY(`lorebook_id`, `target_type`, `target_id`),
	FOREIGN KEY (`lorebook_id`) REFERENCES `lorebooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_lorebook_links_target` ON `lorebook_links` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_lorebook_links_lorebook` ON `lorebook_links` (`lorebook_id`);--> statement-breakpoint
CREATE TABLE `lorebooks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`scope_type` text NOT NULL,
	`scan_depth` integer DEFAULT 10 NOT NULL,
	`token_budget` integer DEFAULT 1000 NOT NULL,
	`token_budget_percent` integer,
	`recursive_scanning` integer DEFAULT 0 NOT NULL,
	`max_recursion_steps` integer DEFAULT 5 NOT NULL,
	`include_names` integer DEFAULT 0 NOT NULL,
	`min_activations` integer DEFAULT 0 NOT NULL,
	`min_activations_depth_max` integer DEFAULT 0 NOT NULL,
	`overflow_alert` integer DEFAULT 0 NOT NULL,
	`character_strategy` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`character_id` text,
	`persona_id` text,
	`chat_id` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`extensions_json` text DEFAULT '{}' NOT NULL,
	`content_hash` text,
	`has_file_on_disk` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_lorebooks_character` ON `lorebooks` (`character_id`);--> statement-breakpoint
CREATE INDEX `idx_lorebooks_persona` ON `lorebooks` (`persona_id`);--> statement-breakpoint
CREATE INDEX `idx_lorebooks_chat` ON `lorebooks` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_lorebooks_scope` ON `lorebooks` (`scope_type`);--> statement-breakpoint
CREATE TABLE `message_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`variant_index` integer NOT NULL,
	`content` text NOT NULL,
	`is_selected` integer DEFAULT 0 NOT NULL,
	`finish_reason` text,
	`reasoning` text,
	`reasoning_duration_ms` integer,
	`model_id` text,
	`preset_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`preset_id`) REFERENCES `prompt_presets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_message_variants_unique` ON `message_variants` (`message_id`,`variant_index`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`role` text NOT NULL,
	`author_type` text NOT NULL,
	`position` integer NOT NULL,
	`content` text NOT NULL,
	`state` text NOT NULL,
	`attachments_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `chat_branches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_messages_branch_position` ON `messages` (`branch_id`,`position`);--> statement-breakpoint
CREATE TABLE `personas` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`pronouns` text,
	`avatar_asset_id` text,
	`avatar_full_asset_id` text,
	`avatar_crop_json` text,
	`avatar_ext` text,
	`avatar_full_ext` text,
	`include_avatar_in_prompt` integer DEFAULT false NOT NULL,
	`avatar_description` text,
	`default_for_new_chats` integer DEFAULT 0 NOT NULL,
	`content_hash` text,
	`has_file_on_disk` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prompt_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`bind_provider_preset_id` text,
	`system_prompt` text DEFAULT '' NOT NULL,
	`post_history_instructions` text DEFAULT '' NOT NULL,
	`assistant_prefix` text DEFAULT '' NOT NULL,
	`authors_note` text DEFAULT '' NOT NULL,
	`authors_note_depth` integer DEFAULT 4 NOT NULL,
	`authors_note_position` text DEFAULT 'in_chat' NOT NULL,
	`authors_note_role` text DEFAULT 'system' NOT NULL,
	`summary_prompt` text DEFAULT '' NOT NULL,
	`tools_prompt` text DEFAULT '' NOT NULL,
	`nsfw_prompt` text DEFAULT '' NOT NULL,
	`enhance_definitions_prompt` text DEFAULT '' NOT NULL,
	`script_ai_system_prompt` text DEFAULT '' NOT NULL,
	`ai_assistant_prompts` text DEFAULT '{}' NOT NULL,
	`custom_injections_json` text DEFAULT '[]' NOT NULL,
	`prompt_order_json` text DEFAULT '[]' NOT NULL,
	`advanced_mode` integer DEFAULT 0 NOT NULL,
	`content_hash` text,
	`has_file_on_disk` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`bind_provider_preset_id`) REFERENCES `provider_profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `prompt_traces` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`message_id` text NOT NULL,
	`model` text NOT NULL,
	`preset_name` text NOT NULL,
	`assembled_layers_json` text NOT NULL,
	`token_accounting_json` text NOT NULL,
	`final_payload_json` text DEFAULT '{}' NOT NULL,
	`activated_lore_entries_json` text DEFAULT '[]' NOT NULL,
	`activated_lore_detail_json` text,
	`retrieved_memories_json` text DEFAULT '[]' NOT NULL,
	`script_injections_json` text DEFAULT '[]' NOT NULL,
	`prefill` text,
	`compaction_summary` text,
	`latency_ms` integer NOT NULL,
	`sent_config_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `chat_branches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_prompt_traces_chat_branch` ON `prompt_traces` (`chat_id`,`branch_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `provider_model_favorites` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_profile_id` text NOT NULL,
	`model_id` text NOT NULL,
	`label` text,
	`context_length` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`provider_profile_id`) REFERENCES `provider_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_provider_model_favorites_unique` ON `provider_model_favorites` (`provider_profile_id`,`model_id`);--> statement-breakpoint
CREATE TABLE `provider_model_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_profile_id` text NOT NULL,
	`model_id` text NOT NULL,
	`settings_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`provider_profile_id`) REFERENCES `provider_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_provider_model_settings_unique` ON `provider_model_settings` (`provider_profile_id`,`model_id`);--> statement-breakpoint
CREATE TABLE `provider_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider_preset` text NOT NULL,
	`endpoint` text NOT NULL,
	`api_key` text,
	`default_model` text,
	`context_budget` integer,
	`pin_context_budget` integer DEFAULT false NOT NULL,
	`bind_per_model` integer DEFAULT false NOT NULL,
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
	`vision_model` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`code` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`scope_type` text DEFAULT 'character' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`character_id` text,
	`persona_id` text,
	`chat_id` text,
	`extensions_json` text DEFAULT '{}' NOT NULL,
	`content_hash` text,
	`has_file_on_disk` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_scripts_character` ON `scripts` (`character_id`);--> statement-breakpoint
CREATE INDEX `idx_scripts_persona` ON `scripts` (`persona_id`);--> statement-breakpoint
CREATE INDEX `idx_scripts_chat` ON `scripts` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_scripts_scope` ON `scripts` (`scope_type`);--> statement-breakpoint
CREATE TABLE `ui_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`theme` text DEFAULT 'dark' NOT NULL,
	`chat_font_size` integer DEFAULT 15 NOT NULL,
	`ui_font_size` integer DEFAULT 14 NOT NULL,
	`message_width` integer DEFAULT 700 NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`active_prompt_preset_id` text,
	`ai_assistant_provider_id` text,
	`ai_assistant_model_name` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`active_prompt_preset_id`) REFERENCES `prompt_presets`(`id`) ON UPDATE no action ON DELETE set null
);
