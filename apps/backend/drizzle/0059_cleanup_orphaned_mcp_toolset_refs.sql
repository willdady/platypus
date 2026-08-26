-- Cleanup for issue #689: routes/mcp.ts's workspace-scope MCP delete never
-- scrubbed the deleted id from referencing Agents' tool_set_ids, unlike the
-- org-scope path. The delete route now scrubs going forward; this one-off
-- backfill removes ids orphaned by deletions that already happened.
--
-- Idempotent: an id is only removed when it's shaped like a generated MCP id
-- (nanoid, 21 chars from [A-Za-z0-9_-]) and no longer resolves to an mcp row.
-- A static/plugin Tool-set id (e.g. "kanban") never matches that shape, so
-- re-running, or running against an Agent with no dangling ids, is a no-op.
--
-- The drop condition lives in a FILTER on the aggregate rather than a WHERE
-- clause on the cross join: an Agent whose *entire* tool_set_ids array is
-- dangling would otherwise contribute zero rows to the join, form no group at
-- all, and so never appear in `sub` — silently skipping the exact Agent that
-- most needs cleaning up. FILTER keeps every element's row in the group and
-- only excludes the dangling ones from jsonb_agg, so an all-dangling array
-- still collapses to '[]'.
UPDATE "agent" a
SET tool_set_ids = sub.kept
FROM (
  SELECT a2.id,
    COALESCE(
      jsonb_agg(elem) FILTER (
        WHERE NOT (elem ~ '^[A-Za-z0-9_-]{21}$' AND NOT EXISTS (
          SELECT 1 FROM "mcp" m WHERE m."id" = elem
        ))
      ),
      '[]'::jsonb
    ) AS kept
  FROM "agent" a2, jsonb_array_elements_text(a2.tool_set_ids) AS elem
  GROUP BY a2.id
) sub
WHERE a.id = sub.id AND a.tool_set_ids IS DISTINCT FROM sub.kept;
