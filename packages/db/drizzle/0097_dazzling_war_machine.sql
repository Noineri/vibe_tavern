ALTER TABLE `chat_branches` ADD `lore_activation_state_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- P14: existing chat-wide state belongs to the currently active branch.
UPDATE `chat_branches`
SET `lore_activation_state_json` = (
  SELECT `lore_activation_state_json`
  FROM `chats`
  WHERE `chats`.`id` = `chat_branches`.`chat_id`
)
WHERE `id` = (
  SELECT `active_branch_id`
  FROM `chats`
  WHERE `chats`.`id` = `chat_branches`.`chat_id`
);--> statement-breakpoint
ALTER TABLE `chats` DROP COLUMN `lore_activation_state_json`;