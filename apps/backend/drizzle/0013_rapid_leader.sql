ALTER TABLE "chat" DROP CONSTRAINT "chat_parent_chat_id_chat_id_fk";
--> statement-breakpoint
DROP INDEX "idx_chat_parent_chat_id";--> statement-breakpoint
ALTER TABLE "chat" DROP COLUMN "parent_chat_id";