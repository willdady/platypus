ALTER TABLE "trigger" RENAME COLUMN "max_chats_to_keep" TO "max_runs_to_keep";--> statement-breakpoint
ALTER TABLE "chat" DROP CONSTRAINT "chat_trigger_id_trigger_id_fk";
--> statement-breakpoint
ALTER TABLE "trigger_run" DROP CONSTRAINT "trigger_run_chat_id_chat_id_fk";
--> statement-breakpoint
DROP INDEX "idx_chat_trigger_id";--> statement-breakpoint
ALTER TABLE "trigger_run" ADD COLUMN "stats" jsonb;--> statement-breakpoint
ALTER TABLE "chat" DROP COLUMN "trigger_id";--> statement-breakpoint
ALTER TABLE "trigger_run" DROP COLUMN "chat_id";