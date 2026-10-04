ALTER TABLE "a2a_token" ADD COLUMN "token_created_at" timestamp;--> statement-breakpoint
ALTER TABLE "a2a_token" ADD COLUMN "token_expires_at" timestamp;--> statement-breakpoint
-- Tokens issued before expiry existed get the default 90-day lifetime from when they were created.
UPDATE "a2a_token" SET "token_created_at" = "created_at", "token_expires_at" = "created_at" + interval '90 days';--> statement-breakpoint
ALTER TABLE "a2a_token" ALTER COLUMN "token_created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "a2a_token" ALTER COLUMN "token_expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "a2a_token" ADD COLUMN "token_notice" text;--> statement-breakpoint
ALTER TABLE "a2a_token" ADD COLUMN "last_used_at" timestamp;--> statement-breakpoint
ALTER TABLE "a2a_token" ADD COLUMN "last_rejected_at" timestamp;
