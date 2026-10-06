CREATE TABLE "a2a_endpoint" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"include_memories" boolean DEFAULT false NOT NULL,
	"extract_memories" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "a2a_push_config" (
	"id" text NOT NULL,
	"task_id" text NOT NULL,
	"url" text NOT NULL,
	"token" text,
	"authentication" jsonb,
	"notified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "a2a_push_config_task_id_id_pk" PRIMARY KEY("task_id","id")
);
--> statement-breakpoint
CREATE TABLE "a2a_task" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" text NOT NULL,
	"endpoint_id" text,
	"token_id" text,
	"state" text,
	"canceled_at" timestamp,
	"status_at" timestamp (3) DEFAULT now() NOT NULL,
	"push_count" integer DEFAULT 0 NOT NULL,
	"reply_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "a2a_token" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_created_at" timestamp NOT NULL,
	"token_expires_at" timestamp NOT NULL,
	"token_notice" text,
	"last_used_at" timestamp,
	"last_rejected_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "a2a_token_id" text;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "a2a_client_name" text;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "a2a_endpoint_id" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "a2a_gate" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "a2a_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "a2a_endpoint" ADD CONSTRAINT "a2a_endpoint_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_endpoint" ADD CONSTRAINT "a2a_endpoint_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_push_config" ADD CONSTRAINT "a2a_push_config_task_id_a2a_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."a2a_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_task" ADD CONSTRAINT "a2a_task_endpoint_id_a2a_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."a2a_endpoint"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_task" ADD CONSTRAINT "a2a_task_token_id_a2a_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."a2a_token"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_task" ADD CONSTRAINT "a2a_task_chat_id_message_id_chat_message_chat_id_id_fk" FOREIGN KEY ("chat_id","message_id") REFERENCES "public"."chat_message"("chat_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_task" ADD CONSTRAINT "a2a_task_reply_fk" FOREIGN KEY ("chat_id","reply_id") REFERENCES "public"."chat_message"("chat_id","id") ON DELETE SET NULL ("reply_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "a2a_token" ADD CONSTRAINT "a2a_token_endpoint_id_a2a_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."a2a_endpoint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_a2a_endpoint_workspace_id" ON "a2a_endpoint" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_a2a_endpoint_agent_id" ON "a2a_endpoint" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_a2a_task_chat_id_message_id" ON "a2a_task" USING btree ("chat_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_a2a_task_endpoint_id" ON "a2a_task" USING btree ("endpoint_id");--> statement-breakpoint
CREATE INDEX "idx_a2a_task_token_id_status_at_id" ON "a2a_task" USING btree ("token_id","status_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "idx_a2a_task_token_id_unended" ON "a2a_task" USING btree ("token_id") WHERE "a2a_task"."state" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_a2a_task_chat_id_reply_id" ON "a2a_task" USING btree ("chat_id","reply_id");--> statement-breakpoint
CREATE INDEX "idx_a2a_token_endpoint_id" ON "a2a_token" USING btree ("endpoint_id");--> statement-breakpoint
ALTER TABLE "chat" ADD CONSTRAINT "chat_a2a_token_id_a2a_token_id_fk" FOREIGN KEY ("a2a_token_id") REFERENCES "public"."a2a_token"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_a2a_token_id" ON "chat" USING btree ("a2a_token_id");