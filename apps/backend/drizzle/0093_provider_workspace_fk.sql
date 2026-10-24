-- Issue #1610: Organization and User deletes left Workspace Providers behind,
-- as Workspace deletes did before migration 0057. Remove them so the FK below
-- can be added. Idempotent: only rows whose workspace_id no longer resolves.
DELETE FROM "provider" p
WHERE p."workspace_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "workspace" w WHERE w."id" = p."workspace_id"
  );--> statement-breakpoint
ALTER TABLE "provider" ADD CONSTRAINT "provider_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;