CREATE TABLE `coauthor_connection_settings` (
	`provider_profile_id` text PRIMARY KEY NOT NULL,
	`model_name` text,
	`settings_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`provider_profile_id`) REFERENCES `provider_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Seed (COAUTHOR_OWN_GENERATION_SETTINGS_PLAN CG-1): the currently bound
-- Co-Author connection keeps the legacy global overrides as its own set. Only
-- the bound provider (JOIN drops a dangling coauthor_provider_id) gets a row;
-- only the explicit legacy values are stored — the domain resolver
-- (resolveCoauthorGenerationSettings) completes the rest from the Co-Author
-- defaults, so no default numbers are frozen into this committed migration.
-- The old ui_settings columns stay (retired in CG-5).
INSERT INTO `coauthor_connection_settings` (`provider_profile_id`, `model_name`, `settings_json`, `created_at`, `updated_at`)
SELECT
  s.`coauthor_provider_id`,
  s.`coauthor_model_name`,
  CASE
    WHEN s.`coauthor_max_tokens` IS NOT NULL AND s.`coauthor_context_budget` IS NOT NULL
      THEN json_object('maxTokens', s.`coauthor_max_tokens`, 'contextBudget', s.`coauthor_context_budget`)
    WHEN s.`coauthor_max_tokens` IS NOT NULL
      THEN json_object('maxTokens', s.`coauthor_max_tokens`)
    WHEN s.`coauthor_context_budget` IS NOT NULL
      THEN json_object('contextBudget', s.`coauthor_context_budget`)
    ELSE '{}'
  END,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `ui_settings` s
JOIN `provider_profiles` p ON p.`id` = s.`coauthor_provider_id`;
