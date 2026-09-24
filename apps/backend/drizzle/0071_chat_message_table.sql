CREATE TABLE "chat_message" (
	"chat_id" text NOT NULL,
	"id" text NOT NULL,
	"parent_id" text,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"metadata" jsonb,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_chat_id_id_pk" PRIMARY KEY("chat_id","id")
);
--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "active_leaf_id" text;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_chat_id_parent_id_chat_message_chat_id_id_fk" FOREIGN KEY ("chat_id","parent_id") REFERENCES "public"."chat_message"("chat_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_id_active_leaf_id_chat_message_chat_id_id_fk" FOREIGN KEY ("id","active_leaf_id") REFERENCES "public"."chat_message"("chat_id","id") ON DELETE no action ON UPDATE no action;