-- Persist ST-like prompt order for preset-owned and built-in prompt slots.
ALTER TABLE `prompt_presets` ADD COLUMN `prompt_order_json` text NOT NULL DEFAULT '[]';
