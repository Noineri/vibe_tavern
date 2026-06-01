-- Lorebook many-to-many links (character/persona).
-- A lorebook can be linked to multiple characters and/or personas.
-- Chat-scoped lorebooks remain 1:1 via the chatId FK on lorebooks.
-- Legacy FK columns (characterId, personaId) are retained as the "primary owner"
-- used by scope-based UI tabs and import/duplicate flows.

CREATE TABLE `lorebook_links` (
  `lorebook_id` text NOT NULL,
  `target_type` text NOT NULL,
  `target_id` text NOT NULL,
  PRIMARY KEY(`lorebook_id`, `target_type`, `target_id`),
  FOREIGN KEY(`lorebook_id`) REFERENCES `lorebooks`(`id`) ON DELETE cascade
);

CREATE INDEX `idx_lorebook_links_target` ON `lorebook_links` (`target_type`,`target_id`);
CREATE INDEX `idx_lorebook_links_lorebook` ON `lorebook_links` (`lorebook_id`);

-- Populate from existing FK columns
INSERT INTO `lorebook_links` (`lorebook_id`, `target_type`, `target_id`)
  SELECT `id`, 'character', `character_id` FROM `lorebooks` WHERE `character_id` IS NOT NULL;

INSERT INTO `lorebook_links` (`lorebook_id`, `target_type`, `target_id`)
  SELECT `id`, 'persona', `persona_id` FROM `lorebooks` WHERE `persona_id` IS NOT NULL;
