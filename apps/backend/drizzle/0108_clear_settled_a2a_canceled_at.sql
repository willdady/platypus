-- Custom SQL migration file, put your code below! --

-- Clear `canceled_at` on settled A2A Tasks before the cancel sweep starts
-- matching turns by identity (ADR-0052). Before that change no run's end ever
-- cleared the stamp, so every Task canceled under the old code keeps
-- `canceled_at` set on a settled row forever. The sweep treats a set stamp as
-- "this cancel is still owed to a run that may be going", so the first
-- regenerate of such a turn after the deploy would be wrongly stopped once.
-- A settled row is never owed anything: the run it belonged to has ended.
-- Runs in production via scripts/migrate.ts. Idempotent: clearing an already
-- NULL column is a no-op. A cancel claimed in the deploy window whose run is
-- still going loses its stamp here; the run timeout bounds it, as ADR-0049
-- already accepts for a cancel missed during a rolling deploy.
UPDATE "a2a_task" SET "canceled_at" = NULL WHERE "state" IS NOT NULL;
