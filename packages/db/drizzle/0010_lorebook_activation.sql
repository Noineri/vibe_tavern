-- Lorebook activation engine columns
ALTER TABLE lorebooks ADD COLUMN include_names integer NOT NULL DEFAULT 0;
ALTER TABLE lorebooks ADD COLUMN min_activations integer NOT NULL DEFAULT 0;
ALTER TABLE lorebooks ADD COLUMN min_activations_depth_max integer NOT NULL DEFAULT 0;
ALTER TABLE lorebooks ADD COLUMN overflow_alert integer NOT NULL DEFAULT 0;
ALTER TABLE lorebooks ADD COLUMN character_strategy integer NOT NULL DEFAULT 0;

ALTER TABLE lore_entries ADD COLUMN ignore_budget integer NOT NULL DEFAULT 0;
ALTER TABLE lore_entries ADD COLUMN use_group_scoring integer NOT NULL DEFAULT 0;
ALTER TABLE lore_entries ADD COLUMN automation_id text DEFAULT NULL;
