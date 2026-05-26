ALTER TABLE characters ADD COLUMN content_hash text;
ALTER TABLE characters ADD COLUMN has_file_on_disk integer NOT NULL DEFAULT 0;

ALTER TABLE personas ADD COLUMN content_hash text;
ALTER TABLE personas ADD COLUMN has_file_on_disk integer NOT NULL DEFAULT 0;

ALTER TABLE lorebooks ADD COLUMN content_hash text;
ALTER TABLE lorebooks ADD COLUMN has_file_on_disk integer NOT NULL DEFAULT 0;

ALTER TABLE lore_entries ADD COLUMN content_hash text;
ALTER TABLE lore_entries ADD COLUMN has_file_on_disk integer NOT NULL DEFAULT 0;

ALTER TABLE prompt_presets ADD COLUMN content_hash text;
ALTER TABLE prompt_presets ADD COLUMN has_file_on_disk integer NOT NULL DEFAULT 0;

ALTER TABLE scripts ADD COLUMN content_hash text;
ALTER TABLE scripts ADD COLUMN has_file_on_disk integer NOT NULL DEFAULT 0;
