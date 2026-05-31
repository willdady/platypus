-- Custom SQL migration file, put your code below! --

-- Auto-attach every existing org-scoped Provider and MCP to all workspaces in
-- its organization, preserving pre-Attachment visibility (#154 / ADR-0007).
-- Org-scoped Providers predate Attachment, and org-scoped MCPs (shipped in
-- 1.87.0) were visible org-wide; gating them without this backfill would make
-- them silently vanish from existing workspaces. Runs in production via
-- scripts/migrate.ts. Idempotent via ON CONFLICT against the unique
-- (workspace_id, resource_type, resource_id) constraint created in 0039.
--
-- NB: `drizzle-kit push` (the dev workflow) does NOT execute migration files,
-- so this backfill does not run in dev — attach org-scoped Shared resources
-- manually via the UI there.
INSERT INTO "attachment" ("id", "workspace_id", "resource_type", "resource_id", "created_at")
SELECT gen_random_uuid()::text, w."id", 'provider', p."id", now()
FROM "provider" p
JOIN "workspace" w ON w."organization_id" = p."organization_id"
WHERE p."organization_id" IS NOT NULL
ON CONFLICT ("workspace_id", "resource_type", "resource_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "attachment" ("id", "workspace_id", "resource_type", "resource_id", "created_at")
SELECT gen_random_uuid()::text, w."id", 'mcp', m."id", now()
FROM "mcp" m
JOIN "workspace" w ON w."organization_id" = m."organization_id"
WHERE m."organization_id" IS NOT NULL
ON CONFLICT ("workspace_id", "resource_type", "resource_id") DO NOTHING;