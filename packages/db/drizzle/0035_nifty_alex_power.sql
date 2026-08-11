ALTER TABLE `experience_visuals` ADD `stable_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `experience_visuals_stable_key_unique` ON `experience_visuals` (`stable_key`);