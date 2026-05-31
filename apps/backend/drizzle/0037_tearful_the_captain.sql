ALTER TABLE "mcp" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "mcp" ADD CONSTRAINT "mcp_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mcp_organization_id" ON "mcp" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "mcp" ADD CONSTRAINT "unique_mcp_name_org" UNIQUE("organization_id","name");--> statement-breakpoint
ALTER TABLE "mcp" ADD CONSTRAINT "unique_mcp_name_workspace" UNIQUE("workspace_id","name");