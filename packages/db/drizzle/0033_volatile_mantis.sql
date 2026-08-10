CREATE TABLE `experience_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`session_id` text NOT NULL,
	`session_revision` integer NOT NULL,
	`queue_revision` integer NOT NULL,
	`kind` text NOT NULL,
	`public_events_json` text NOT NULL,
	`hidden_state_checkpoint_json` text NOT NULL,
	`rules_source_hash` text NOT NULL,
	`visual_source_hash` text,
	`bound_message_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `chat_branches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bound_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_experience_attachments_session` ON `experience_attachments` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_experience_attachments_message` ON `experience_attachments` (`bound_message_id`);--> statement-breakpoint
CREATE INDEX `idx_experience_attachments_chat_branch` ON `experience_attachments` (`chat_id`,`branch_id`);--> statement-breakpoint
CREATE TABLE `experience_chat_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`script_id` text,
	`visual_id` text,
	`capability_grants_json` text DEFAULT '[]' NOT NULL,
	`context_mode` text DEFAULT 'none' NOT NULL,
	`launcher_visible` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`script_id`) REFERENCES `scripts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`visual_id`) REFERENCES `experience_visuals`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_experience_chat_configs_chat` ON `experience_chat_configs` (`chat_id`);--> statement-breakpoint
CREATE TABLE `experience_context_bundles` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`mode` text NOT NULL,
	`branch_frontier_revision` integer,
	`message_frontier_position` integer,
	`variants_json` text,
	`compact_summary_json` text,
	`character_snapshot_json` text,
	`persona_snapshot_json` text,
	`source_hashes_json` text,
	`provider_profile_id` text,
	`model_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `experience_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_experience_context_bundles_session` ON `experience_context_bundles` (`session_id`);--> statement-breakpoint
CREATE TABLE `experience_effects` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`originating_revision` integer NOT NULL,
	`request_json` text NOT NULL,
	`result_json` text,
	`error` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `experience_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_experience_effects_session` ON `experience_effects` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_experience_effects_status` ON `experience_effects` (`status`);--> statement-breakpoint
CREATE TABLE `experience_prompt_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text NOT NULL,
	`character_id` text,
	`content` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_experience_prompt_overrides_scope_character` ON `experience_prompt_overrides` (`scope_type`,`character_id`);--> statement-breakpoint
CREATE TABLE `experience_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`branch_id` text NOT NULL,
	`active_slot` integer,
	`rules_id` text NOT NULL,
	`rules_label` text NOT NULL,
	`rules_revision` integer NOT NULL,
	`rules_source` text NOT NULL,
	`rules_source_hash` text NOT NULL,
	`visual_id` text,
	`visual_label` text,
	`visual_revision` integer,
	`visual_source` text,
	`visual_source_hash` text,
	`api_version` integer NOT NULL,
	`manifest_id` text NOT NULL,
	`manifest_name` text NOT NULL,
	`initial_settings_json` text NOT NULL,
	`current_state_json` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`participants_json` text DEFAULT '[]' NOT NULL,
	`capability_grants_json` text DEFAULT '[]' NOT NULL,
	`context_mode` text DEFAULT 'none' NOT NULL,
	`report_frontier` integer DEFAULT 0 NOT NULL,
	`random_seed` text NOT NULL,
	`random_cursor` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `chat_branches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_experience_sessions_branch_slot` ON `experience_sessions` (`branch_id`,`active_slot`);--> statement-breakpoint
CREATE INDEX `idx_experience_sessions_chat` ON `experience_sessions` (`chat_id`);--> statement-breakpoint
CREATE INDEX `idx_experience_sessions_branch` ON `experience_sessions` (`branch_id`);--> statement-breakpoint
CREATE TABLE `experience_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`request_id` text,
	`expected_revision` integer,
	`applied_revision` integer,
	`actor_snapshot_json` text,
	`input_json` text,
	`emitted_events_json` text DEFAULT '[]' NOT NULL,
	`emitted_effects_json` text DEFAULT '[]' NOT NULL,
	`state_hash` text,
	`message` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `experience_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_experience_steps_session_sequence` ON `experience_steps` (`session_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_experience_steps_session_request` ON `experience_steps` (`session_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `idx_experience_steps_session` ON `experience_steps` (`session_id`);--> statement-breakpoint
CREATE TABLE `experience_visuals` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`source_hash` text NOT NULL,
	`api_version` integer NOT NULL,
	`compatible_manifest_ids_json` text DEFAULT '[]' NOT NULL,
	`scope_type` text DEFAULT 'global' NOT NULL,
	`character_id` text,
	`persona_id` text,
	`chat_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_experience_visuals_scope` ON `experience_visuals` (`scope_type`);--> statement-breakpoint
CREATE INDEX `idx_experience_visuals_character` ON `experience_visuals` (`character_id`);--> statement-breakpoint
CREATE INDEX `idx_experience_visuals_persona` ON `experience_visuals` (`persona_id`);--> statement-breakpoint
CREATE INDEX `idx_experience_visuals_chat` ON `experience_visuals` (`chat_id`);