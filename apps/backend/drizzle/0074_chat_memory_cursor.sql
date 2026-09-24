ALTER TABLE "chat" ADD COLUMN "memory_cursor_id" text;--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_id_memory_cursor_id_chat_message_chat_id_id_fk" FOREIGN KEY ("id","memory_cursor_id") REFERENCES "public"."chat_message"("chat_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A Chat already caught up starts with its cursor at its leaf, so the first
-- pass after the upgrade does not read it all again. Every other Chat starts
-- null, and its whole Active path is new. That includes a null `last_turn_at`:
-- nothing shows such a Chat was read after its last turn.
--
-- `drizzle-kit push` does not run this file.
UPDATE "chat" SET "memory_cursor_id" = "active_leaf_id"
WHERE "memory_extraction_status" = 'completed'
  AND "last_memory_processed_at" >= "last_turn_at";
