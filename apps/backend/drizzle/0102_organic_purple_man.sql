ALTER TABLE "trigger_run_event" DROP CONSTRAINT "trigger_run_event_type_allowed";--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "fallback_provider_id" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "fallback_model_id" text;--> statement-breakpoint
ALTER TABLE "trigger_run_event" ADD COLUMN "model_switch" jsonb;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_fallback_provider_id_provider_id_fk" FOREIGN KEY ("fallback_provider_id") REFERENCES "public"."provider"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_fallback_provider_id" ON "agent" USING btree ("fallback_provider_id");--> statement-breakpoint
ALTER TABLE "trigger_run_event" ADD CONSTRAINT "trigger_run_event_type_allowed" CHECK ("trigger_run_event"."type" in ('tool-call', 'tool-input', 'reasoning', 'text', 'delegate', 'model-switch'));