-- TD-005: drop the deprecated is_system column and remove the orphaned
-- char_system seed row (pre-wizard free-chat placeholder). Safe to delete:
-- all FKs to characters cascade, and no chats/messages reference char_system.
DELETE FROM `characters` WHERE `id` = 'char_system';

ALTER TABLE `characters` DROP COLUMN `is_system`;
