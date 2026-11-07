ALTER TABLE "chat" ADD COLUMN "trigger_run_id" text;--> statement-breakpoint
ALTER TABLE "trigger" ADD COLUMN "extract_memories" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_trigger_run_id_trigger_run_id_fk" FOREIGN KEY ("trigger_run_id") REFERENCES "public"."trigger_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_trigger_run_id" ON "chat" USING btree ("trigger_run_id");--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_one_binding" CHECK ("chat"."a2a_endpoint_id" is null or "chat"."trigger_run_id" is null);