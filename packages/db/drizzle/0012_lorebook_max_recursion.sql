-- Add missing max_recursion_steps column for recursive lorebook scanning
ALTER TABLE lorebooks ADD COLUMN max_recursion_steps integer NOT NULL DEFAULT 5;
