CREATE TABLE "context" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_context_user_workspace" UNIQUE("user_id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "context" ADD CONSTRAINT "context_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context" ADD CONSTRAINT "context_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_context_user_id" ON "context" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_context_workspace_id" ON "context" USING btree ("workspace_id");