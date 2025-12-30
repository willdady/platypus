CREATE TABLE "skill" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_skill_name_workspace" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "skill_ids" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_skill_workspace_id" ON "skill" USING btree ("workspace_id");