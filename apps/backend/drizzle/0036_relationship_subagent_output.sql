-- Convert agent.sub_agent_ids from a flat string array of sub-agent ids:
--    ["id1", "id2"]
-- to an object array carrying per-relationship configuration:
--    [{"id": "id1"}, {"id": "id2"}]
--
-- This migration is required because parentOutput (how much of a sub-agent's
-- response text is returned to the parent's context window) is now configured
-- per parent→sub-agent edge rather than as a global property of the sub-agent.
-- Storing the config alongside the id lets the same sub-agent be reused from
-- multiple parents with different context budgets.
--
-- Idempotent: only rewrites rows whose first element is still a plain string.

UPDATE "agent"
SET "sub_agent_ids" = (
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN jsonb_typeof(elem) = 'string' THEN jsonb_build_object('id', elem #>> '{}')
        ELSE elem
      END
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements("sub_agent_ids") AS elem
)
WHERE "sub_agent_ids" IS NOT NULL
  AND jsonb_array_length("sub_agent_ids") > 0
  AND jsonb_typeof("sub_agent_ids" -> 0) = 'string';
