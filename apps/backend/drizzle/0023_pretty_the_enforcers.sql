CREATE TABLE "trigger" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"instruction" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_chats_to_keep" integer DEFAULT 50 NOT NULL,
	"search" boolean DEFAULT false NOT NULL,
	"config" jsonb NOT NULL,
	"last_run_at" timestamp,
	"next_run_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_run" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger_id" text NOT NULL,
	"chat_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"event_type" text,
	"event_data" jsonb,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "schedule_run" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "schedule" CASCADE;--> statement-breakpoint
DROP TABLE "schedule_run" CASCADE;--> statement-breakpoint
ALTER TABLE "chat" DROP CONSTRAINT "chat_schedule_id_schedule_id_fk";
--> statement-breakpoint
DROP INDEX "idx_chat_schedule_id";--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "trigger_id" text;--> statement-breakpoint
ALTER TABLE "trigger" ADD CONSTRAINT "trigger_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger" ADD CONSTRAINT "trigger_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_run" ADD CONSTRAINT "trigger_run_trigger_id_trigger_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."trigger"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_run" ADD CONSTRAINT "trigger_run_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_trigger_workspace_id" ON "trigger" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_trigger_next_run_at" ON "trigger" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "idx_trigger_type" ON "trigger" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_trigger_run_trigger_id" ON "trigger_run" USING btree ("trigger_id");--> statement-breakpoint
CREATE INDEX "idx_trigger_run_started_at" ON "trigger_run" USING btree ("started_at");--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_trigger_id_trigger_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."trigger"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_trigger_id" ON "chat" USING btree ("trigger_id");--> statement-breakpoint
ALTER TABLE "chat" DROP COLUMN "schedule_id";