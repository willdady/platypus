-- The schedules→triggers rename changed the core Tool set id; rewrite grants
-- stored under the old id, de-duplicating Agents that already have both. Order
-- is kept (first occurrence wins) since it sets Tool name precedence.
UPDATE "agent"
SET "tool_set_ids" = (
  SELECT jsonb_agg("id" ORDER BY "first")
  FROM (
    SELECT CASE WHEN v = 'schedule' THEN 'triggers' ELSE v END AS "id", min(o) AS "first"
    FROM jsonb_array_elements_text("tool_set_ids") WITH ORDINALITY AS t(v, o)
    GROUP BY 1
  ) s
)
WHERE "tool_set_ids" ? 'schedule';
