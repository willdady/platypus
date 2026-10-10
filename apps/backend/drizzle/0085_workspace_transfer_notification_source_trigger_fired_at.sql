ALTER TABLE "notification" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "source_chat_id" text;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "source_trigger_run_id" text;--> statement-breakpoint
ALTER TABLE "trigger" ADD COLUMN "fired_at" timestamp;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_source_chat_id_chat_id_fk" FOREIGN KEY ("source_chat_id") REFERENCES "public"."chat"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_source_trigger_run_id_trigger_run_id_fk" FOREIGN KEY ("source_trigger_run_id") REFERENCES "public"."trigger_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notification_source_chat_id" ON "notification" USING btree ("source_chat_id");--> statement-breakpoint
CREATE INDEX "idx_notification_source_trigger_run_id" ON "notification" USING btree ("source_trigger_run_id");--> statement-breakpoint
-- A One-off the scheduler already claimed was disabled with its schedule
-- cleared; one disabled by hand keeps its `next_run_at`. `last_run_at` is
-- written only when a run completes, so one whose run was suppressed or died
-- falls back to the claim's own `updated_at`.
UPDATE "trigger" SET "fired_at" = COALESCE("last_run_at", "updated_at")
WHERE "type" = 'cron'
  AND "config"->>'isOneOff' = 'true'
  AND "enabled" = false
  AND "next_run_at" IS NULL;
