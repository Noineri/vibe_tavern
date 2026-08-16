CREATE TABLE `script_visuals` (
	`script_id` text NOT NULL,
	`visual_id` text NOT NULL,
	PRIMARY KEY(`script_id`, `visual_id`),
	FOREIGN KEY (`script_id`) REFERENCES `scripts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`visual_id`) REFERENCES `experience_visuals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_script_visuals_script` ON `script_visuals` (`script_id`);--> statement-breakpoint
CREATE INDEX `idx_script_visuals_visual` ON `script_visuals` (`visual_id`);--> statement-breakpoint
-- Backfill (BE-5): every script with a primary visual (`default_visual_id`)
-- gets a junction row so "primary ∈ bound set" holds for upgrades from the
-- Wave 1 seed (which set defaultVisualId before the junction existed). The
-- EXISTS guard skips stale defaults pointing at a since-deleted visual —
-- robust whether or not FKs are enforced during the migration phase.
INSERT INTO `script_visuals` (`script_id`, `visual_id`)
SELECT s.`id`, s.`default_visual_id`
FROM `scripts` s
WHERE s.`default_visual_id` IS NOT NULL
  AND EXISTS (SELECT 1 FROM `experience_visuals` v WHERE v.`id` = s.`default_visual_id`)
ON CONFLICT(`script_id`, `visual_id`) DO NOTHING;