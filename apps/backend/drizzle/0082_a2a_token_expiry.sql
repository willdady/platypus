ALTER TABLE "a2a_token" ADD COLUMN "token_created_at" timestamp NOT NULL;--> statement-breakpoint
ALTER TABLE "a2a_token" ADD COLUMN "token_expires_at" timestamp NOT NULL;--> statement-breakpoint
ALTER TABLE "a2a_token" ADD COLUMN "token_notice" text;--> statement-breakpoint
ALTER TABLE "a2a_token" ADD COLUMN "last_used_at" timestamp;--> statement-breakpoint
ALTER TABLE "a2a_token" ADD COLUMN "last_rejected_at" timestamp;