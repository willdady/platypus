ALTER TABLE "agent" ADD COLUMN "compaction_enabled" boolean;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "trigger_ratio" real;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "target_ratio" real;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "reserve_ratio" real;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "keep_recent_messages" integer;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "min_prunable_chars" integer;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "context_summary" text;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "summary_watermark" text;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "compaction_dirty" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "model_meta" jsonb;