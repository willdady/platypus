ALTER TABLE "agent" ADD COLUMN "sub_agent_ids" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "parent_chat_id" text;--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_parent_chat_id_chat_id_fk" FOREIGN KEY ("parent_chat_id") REFERENCES "public"."chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_parent_chat_id" ON "chat" USING btree ("parent_chat_id");