-- Before the constraints below can be added, drop the duplicates the old ones
-- let through: a second global Context (null workspace_id never collided) and
-- a second membership of the same Organization.
--
-- A user keeps their most recently edited global Context (then newest, then
-- highest id), the one they last wrote and most likely the one in effect, since
-- prompt assembly took whichever duplicate it read last. A membership keeps the
-- oldest row (ties broken by id).
--
-- `drizzle-kit push` does not run this file.
DELETE FROM "context" c
USING "context" keep
WHERE c."user_id" = keep."user_id"
  AND c."workspace_id" IS NOT DISTINCT FROM keep."workspace_id"
  AND (keep."updated_at", keep."created_at", keep."id") > (c."updated_at", c."created_at", c."id");--> statement-breakpoint
DELETE FROM "organization_member" m
USING "organization_member" keep
WHERE m."organization_id" = keep."organization_id"
  AND m."user_id" = keep."user_id"
  AND (keep."created_at", keep."id") < (m."created_at", m."id");--> statement-breakpoint
ALTER TABLE "context" DROP CONSTRAINT "unique_context_user_workspace";--> statement-breakpoint
ALTER TABLE "context" ADD CONSTRAINT "unique_context_user_workspace" UNIQUE NULLS NOT DISTINCT("user_id","workspace_id");--> statement-breakpoint
ALTER TABLE "organization_member" ADD CONSTRAINT "unique_org_member_org_user" UNIQUE("organization_id","user_id");
