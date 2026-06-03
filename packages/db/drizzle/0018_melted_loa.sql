-- Checkpoint: schema snapshot aligned with manual migrations 0003-0018.
-- This migration is a no-op; its purpose is to provide a drizzle-kit snapshot
-- so that future `db:generate` calls produce incremental diffs instead of
-- regenerating all accumulated changes from the ancient 0002_snapshot.
SELECT 1;
