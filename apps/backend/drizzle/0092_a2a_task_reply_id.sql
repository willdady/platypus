ALTER TABLE "a2a_task" ADD COLUMN "reply_id" text;--> statement-breakpoint
ALTER TABLE "a2a_task" ADD CONSTRAINT "a2a_task_reply_fk" FOREIGN KEY ("chat_id","reply_id") REFERENCES "public"."chat_message"("chat_id","id") ON DELETE SET NULL ("reply_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_a2a_task_chat_id_reply_id" ON "a2a_task" USING btree ("chat_id","reply_id");