DROP TABLE "dashboard" CASCADE;--> statement-breakpoint
DROP TABLE "widget" CASCADE;--> statement-breakpoint
-- The `dashboards` core Tool set is gone (#1430). An Agent still granting it
-- would hit an MCP lookup every turn and fail the Shared Agent reference check.
-- jsonb `-` drops every matching element and keeps the rest in order.
UPDATE "agent"
SET "tool_set_ids" = "tool_set_ids" - 'dashboards'
WHERE "tool_set_ids" ? 'dashboards';
