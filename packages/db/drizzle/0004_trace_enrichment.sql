ALTER TABLE `prompt_traces` ADD `activated_lore_entries_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `prompt_traces` ADD `retrieved_memories_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `prompt_traces` ADD `script_injections_json` text DEFAULT '[]' NOT NULL;
