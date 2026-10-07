ALTER TABLE "chat" ADD COLUMN "run_heartbeat_at" timestamp;--> statement-breakpoint
UPDATE "provider" SET "memory_extraction_model_id" = '' WHERE "memory_extraction_model_id" IS NULL;--> statement-breakpoint
ALTER TABLE "provider" ALTER COLUMN "memory_extraction_model_id" SET NOT NULL;
