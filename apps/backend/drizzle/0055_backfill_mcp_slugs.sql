-- Backfill mcp.slug from name (issue #467): lowercase, non-alphanumeric runs
-- collapsed to a single underscore, edges trimmed — the same rule as
-- `slugifyMcpName` in packages/schemas, so the backend and this one-time
-- backfill agree exactly on what a given name slugifies to.
--
-- Two MCPs in the same scope can slugify onto the same value even though
-- their names are legally distinct today (e.g. "Marys MCP Server" and
-- "Mary's MCP Server" both -> marys_mcp_server), so this is not a rename —
-- it disambiguates a pre-existing collision by appending "_2", "_3", ... in
-- creation order, unblocking the unique constraint the next migration adds.
-- A collision between an org-scoped and a workspace-scoped row is not
-- resolved here: cross-scope slug sharing is allowed by design (they can
-- both attach to one Agent — ADR-0007), and is handled at Chat-turn time.
WITH slugged AS (
  SELECT
    id,
    organization_id,
    workspace_id,
    created_at,
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(name), '[''’]', '', 'g'),
        '[^a-z0-9]+', '_', 'g'
      ),
      '^_+|_+$', '', 'g'
    ) AS base_slug
  FROM "mcp"
),
ranked AS (
  SELECT
    id,
    base_slug,
    row_number() OVER (
      PARTITION BY organization_id, workspace_id, base_slug
      ORDER BY created_at, id
    ) AS rn
  FROM slugged
)
UPDATE "mcp"
SET "slug" = CASE
  WHEN ranked.rn = 1 THEN ranked.base_slug
  ELSE ranked.base_slug || '_' || ranked.rn::text
END
FROM ranked
WHERE "mcp".id = ranked.id;
