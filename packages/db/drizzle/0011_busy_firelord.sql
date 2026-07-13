ALTER TABLE `chats` ADD `insights_config_json` text DEFAULT '{"objectiveEnabled":false,"trackerEnabled":false}' NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `insights_objective_state_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `chats` ADD `insights_current_scene_json` text DEFAULT '{}' NOT NULL;