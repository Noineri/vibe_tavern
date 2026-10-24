CREATE TABLE `skill_orders` (
	`library` text NOT NULL,
	`skill_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`library`, `skill_id`)
);
