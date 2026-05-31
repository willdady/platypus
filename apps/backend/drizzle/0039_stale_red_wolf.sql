CREATE TABLE "attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_attachment" UNIQUE("workspace_id","resource_type","resource_id")
);
--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_attachment_workspace" ON "attachment" USING btree ("workspace_id","resource_type");--> statement-breakpoint
CREATE INDEX "idx_attachment_resource" ON "attachment" USING btree ("resource_type","resource_id");