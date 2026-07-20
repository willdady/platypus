ALTER TABLE "chat" ADD COLUMN "context_summary" text;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "summary_watermark" text;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "compaction_dirty" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "model_meta" jsonb;