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
ALTER TABLE "a2a_push_config" ADD CONSTRAINT "a2a_push_config_task_id_a2a_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."a2a_task"("id") ON DELETE cascade ON UPDATE no action;