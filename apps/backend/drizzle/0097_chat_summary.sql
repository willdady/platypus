CREATE TABLE "chat_summary" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"anchor_id" text NOT NULL,
	"covered_ids" jsonb NOT NULL,
	"text" text NOT NULL,
	"stats" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_summary" ADD CONSTRAINT "chat_summary_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_summary" ADD CONSTRAINT "chat_summary_chat_id_anchor_id_chat_message_chat_id_id_fk" FOREIGN KEY ("chat_id","anchor_id") REFERENCES "public"."chat_message"("chat_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_summary_chat_id_created_at" ON "chat_summary" USING btree ("chat_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "idx_chat_summary_chat_id_anchor_id" ON "chat_summary" USING btree ("chat_id","anchor_id");