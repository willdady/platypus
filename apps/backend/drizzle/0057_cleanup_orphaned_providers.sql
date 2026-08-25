-- Cleanup for issue #661: `provider.workspace_id` has never carried a FK to
-- `workspace`, so every past Workspace deletion left that Workspace's own
-- Providers behind as orphaned rows — disconnected from any Workspace,
-- invisible in the UI, still holding a live `api_key`. The Workspace delete
-- route now deletes these explicitly going forward; this one-off backfill
-- removes rows orphaned by deletions that already happened.
--
-- Idempotent: a row is only removed when its workspace_id is set and no
-- longer resolves to an existing workspace, so re-running is a no-op.
DELETE FROM "provider" p
WHERE p."workspace_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "workspace" w WHERE w."id" = p."workspace_id"
  );
