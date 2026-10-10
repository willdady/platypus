ALTER TABLE "trigger" ADD COLUMN "fired_at" timestamp;--> statement-breakpoint
-- A One-off the scheduler already claimed was disabled with its schedule
-- cleared; one disabled by hand keeps its `next_run_at`.
UPDATE "trigger" SET "fired_at" = "last_run_at"
WHERE "type" = 'cron'
  AND "config"->>'isOneOff' = 'true'
  AND "enabled" = false
  AND "next_run_at" IS NULL
  AND "last_run_at" IS NOT NULL;
