CREATE TABLE "a2a_task" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" text NOT NULL,
	"endpoint_id" text,
	"token_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "a2a_token_id" text;--> statement-breakpoint
ALTER TABLE "a2a_task" ADD CONSTRAINT "a2a_task_endpoint_id_a2a_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."a2a_endpoint"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_task" ADD CONSTRAINT "a2a_task_token_id_a2a_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."a2a_token"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_task" ADD CONSTRAINT "a2a_task_chat_id_message_id_chat_message_chat_id_id_fk" FOREIGN KEY ("chat_id","message_id") REFERENCES "public"."chat_message"("chat_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_a2a_task_chat_id_message_id" ON "a2a_task" USING btree ("chat_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_a2a_task_endpoint_id" ON "a2a_task" USING btree ("endpoint_id");--> statement-breakpoint
CREATE INDEX "idx_a2a_task_token_id" ON "a2a_task" USING btree ("token_id");--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_a2a_token_id_a2a_token_id_fk" FOREIGN KEY ("a2a_token_id") REFERENCES "public"."a2a_token"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_a2a_token_id" ON "chat" USING btree ("a2a_token_id");