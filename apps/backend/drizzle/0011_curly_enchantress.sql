CREATE TABLE "memory" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"chat_id" text,
	"entity_type" text NOT NULL,
	"entity_name" text NOT NULL,
	"observation" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "last_memory_processed_at" timestamp;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "memory_extraction_status" text DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "memory_extraction_model_id" text;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "memory_extraction_provider_id" text;--> statement-breakpoint
ALTER TABLE "memory" ADD CONSTRAINT "memory_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory" ADD CONSTRAINT "memory_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory" ADD CONSTRAINT "memory_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memory_user_workspace" ON "memory" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "idx_memory_chat_id" ON "memory" USING btree ("chat_id");--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_memory_extraction_provider_id_provider_id_fk" FOREIGN KEY ("memory_extraction_provider_id") REFERENCES "public"."provider"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_memory_processing" ON "chat" USING btree ("memory_extraction_status","last_memory_processed_at","updated_at");