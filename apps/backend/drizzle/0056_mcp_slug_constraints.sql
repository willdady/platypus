ALTER TABLE "mcp" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp" ADD CONSTRAINT "unique_mcp_slug_org" UNIQUE("organization_id","slug");--> statement-breakpoint
ALTER TABLE "mcp" ADD CONSTRAINT "unique_mcp_slug_workspace" UNIQUE("workspace_id","slug");