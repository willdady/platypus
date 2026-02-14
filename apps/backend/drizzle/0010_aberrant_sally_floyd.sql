-- Step 1: Add owner_id as nullable first
ALTER TABLE "workspace" ADD COLUMN "owner_id" text;--> statement-breakpoint

-- Step 2: Backfill owner_id from workspace_member (prefer admin, then first member)
UPDATE "workspace" w
SET "owner_id" = COALESCE(
  (SELECT wm."user_id" FROM "workspace_member" wm WHERE wm."workspace_id" = w."id" AND wm."role" = 'admin' LIMIT 1),
  (SELECT wm."user_id" FROM "workspace_member" wm WHERE wm."workspace_id" = w."id" LIMIT 1),
  (SELECT om."user_id" FROM "organization_member" om WHERE om."organization_id" = w."organization_id" AND om."role" = 'admin' LIMIT 1)
);--> statement-breakpoint

-- Step 3: Make owner_id NOT NULL now that data is backfilled
ALTER TABLE "workspace" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint

-- Step 4: Add FK constraint and index for owner_id
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workspace_owner_id" ON "workspace" USING btree ("owner_id");--> statement-breakpoint

-- Step 5: Drop workspace_member table
ALTER TABLE "workspace_member" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "workspace_member" CASCADE;--> statement-breakpoint

-- Step 6: Simplify invitation table (remove workspace references)
ALTER TABLE "invitation" DROP CONSTRAINT "unique_invitation_workspace_email";--> statement-breakpoint
ALTER TABLE "invitation" DROP CONSTRAINT "invitation_workspace_id_workspace_id_fk";--> statement-breakpoint
DROP INDEX "idx_invitation_workspace_id";--> statement-breakpoint
ALTER TABLE "invitation" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "invitation" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "unique_invitation_org_email" UNIQUE("organization_id","email");
