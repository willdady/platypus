ALTER TABLE "notification" ADD COLUMN "source_chat_id" text;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "source_trigger_run_id" text;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_source_chat_id_chat_id_fk" FOREIGN KEY ("source_chat_id") REFERENCES "public"."chat"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_source_trigger_run_id_trigger_run_id_fk" FOREIGN KEY ("source_trigger_run_id") REFERENCES "public"."trigger_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notification_source_chat_id" ON "notification" USING btree ("source_chat_id");--> statement-breakpoint
CREATE INDEX "idx_notification_source_trigger_run_id" ON "notification" USING btree ("source_trigger_run_id");