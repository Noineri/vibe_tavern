ALTER TABLE `copilot_profiles` ADD `sort_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
WITH ranked_profiles AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY agent_kind ORDER BY created_at ASC, id ASC) - 1 AS sort_order
  FROM copilot_profiles
)
UPDATE copilot_profiles
SET sort_order = (
  SELECT sort_order
  FROM ranked_profiles
  WHERE ranked_profiles.id = copilot_profiles.id
);
