ALTER TABLE "a2a_endpoint" ADD COLUMN "include_memories" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "a2a_endpoint" ADD COLUMN "extract_memories" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "a2a_endpoint_id" text;