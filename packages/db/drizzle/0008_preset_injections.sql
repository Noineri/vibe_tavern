ALTER TABLE prompt_presets ADD COLUMN custom_injections_json text NOT NULL DEFAULT '[]';
