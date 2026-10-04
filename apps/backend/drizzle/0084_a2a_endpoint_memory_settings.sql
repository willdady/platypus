ALTER TABLE "a2a_endpoint" ADD COLUMN "include_memories" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "a2a_endpoint" ADD COLUMN "extract_memories" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "a2a_endpoint_id" text;--> statement-breakpoint
-- A Chat already started over A2A takes its token's endpoint, so it stays out of memory extraction like a new one.
UPDATE "chat" SET "a2a_endpoint_id" = "a2a_token"."endpoint_id" FROM "a2a_token" WHERE "chat"."a2a_token_id" = "a2a_token"."id";
--> statement-breakpoint
-- One whose token is gone takes the endpoint from its Tasks instead.
UPDATE "chat" SET "a2a_endpoint_id" = "a2a_task"."endpoint_id" FROM "a2a_task" WHERE "chat"."a2a_endpoint_id" IS NULL AND "a2a_task"."chat_id" = "chat"."id" AND "a2a_task"."endpoint_id" IS NOT NULL;
