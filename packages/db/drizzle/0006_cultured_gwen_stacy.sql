ALTER TABLE `message_variants` ADD `tool_calls_json` text;--> statement-breakpoint
ALTER TABLE `message_variants` ADD `tool_call_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `tool_calls_json` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `tool_call_id` text;