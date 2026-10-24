ALTER TABLE `coauthor_modules` ADD `sort_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
WITH ranked_modules AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) - 1 AS sort_order
  FROM coauthor_modules
)
UPDATE coauthor_modules
SET sort_order = (
  SELECT sort_order
  FROM ranked_modules
  WHERE ranked_modules.id = coauthor_modules.id
);
