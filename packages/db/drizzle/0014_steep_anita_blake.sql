ALTER TABLE `prompt_presets` ADD `sort_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_profiles` ADD `sort_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill sort_order to the existing list order (created_at ASC, rowid ASC
-- tiebreak) so the new column does not scramble current preset/profile order.
UPDATE `prompt_presets`
SET `sort_order` = (
  SELECT COUNT(*) FROM `prompt_presets` AS p2
  WHERE p2.`created_at` < `prompt_presets`.`created_at`
     OR (p2.`created_at` = `prompt_presets`.`created_at` AND p2.rowid < `prompt_presets`.rowid)
);--> statement-breakpoint
UPDATE `provider_profiles`
SET `sort_order` = (
  SELECT COUNT(*) FROM `provider_profiles` AS p2
  WHERE p2.`created_at` < `provider_profiles`.`created_at`
     OR (p2.`created_at` = `provider_profiles`.`created_at` AND p2.rowid < `provider_profiles`.rowid)
);