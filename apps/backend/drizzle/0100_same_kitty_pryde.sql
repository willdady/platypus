-- Schema hardening (#1770): backfill legacy nulls and Trigger configs, then let
-- the database enforce nullability, closed sets and scope exclusivity.
--
-- The data steps below are idempotent: each `WHERE` matches nothing on a second
-- run, so re-applying this file is safe. `drizzle-kit push` does not run this
-- file; a dev database needs `pnpm drizzle-kit-migrate`.

-- Agent id arrays: rows written before the columns existed have no value.
UPDATE "agent" SET "tool_set_ids" = '[]'::jsonb WHERE "tool_set_ids" IS NULL;--> statement-breakpoint
UPDATE "agent" SET "skill_ids" = '[]'::jsonb WHERE "skill_ids" IS NULL;--> statement-breakpoint
UPDATE "agent" SET "sub_agent_ids" = '[]'::jsonb WHERE "sub_agent_ids" IS NULL;--> statement-breakpoint
ALTER TABLE "agent" ALTER COLUMN "tool_set_ids" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ALTER COLUMN "skill_ids" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ALTER COLUMN "sub_agent_ids" SET NOT NULL;--> statement-breakpoint

-- Chat tags, same story.
UPDATE "chat" SET "tags" = '[]'::jsonb WHERE "tags" IS NULL;--> statement-breakpoint
ALTER TABLE "chat" ALTER COLUMN "tags" SET NOT NULL;--> statement-breakpoint

-- A Chat's heartbeat: judged on its turn's start before the column existed, so
-- seed it from that, else the row's own update time. `default now()` then gives
-- a never-run Chat a stamp.
UPDATE "chat"
SET "run_heartbeat_at" = COALESCE("last_turn_at", "updated_at")
WHERE "run_heartbeat_at" IS NULL;--> statement-breakpoint
ALTER TABLE "chat" ALTER COLUMN "run_heartbeat_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "chat" ALTER COLUMN "run_heartbeat_at" SET NOT NULL;--> statement-breakpoint

-- 0070 filled only pending, unexpired invitations; accepted, declined and
-- expired rows it skipped still need a value before the column can be NOT NULL.
UPDATE "invitation"
SET "token" = gen_random_uuid()::text
WHERE "token" IS NULL;--> statement-breakpoint
ALTER TABLE "invitation" ALTER COLUMN "token" SET NOT NULL;--> statement-breakpoint

-- The daily-summary cap had a column default but no NOT NULL.
UPDATE "workspace" SET "max_daily_summaries" = 90 WHERE "max_daily_summaries" IS NULL;--> statement-breakpoint
ALTER TABLE "workspace" ALTER COLUMN "max_daily_summaries" SET NOT NULL;--> statement-breakpoint

-- The banned flag had a column default but no NOT NULL.
UPDATE "user" SET "banned" = false WHERE "banned" IS NULL;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "banned" SET NOT NULL;--> statement-breakpoint

-- A Trigger's `config` was stored as the schema's INPUT, so a row written
-- before a field existed lacks it. Fill the fields each type gained after its
-- first rows were written; a config that still does not validate stops the
-- migration below rather than being guessed at.
--
-- Cron gained `timezone` and `isOneOff`.
UPDATE "trigger"
SET "config" = "config"
  || CASE WHEN "config" ? 'timezone' THEN '{}'::jsonb ELSE '{"timezone":"UTC"}'::jsonb END
  || CASE WHEN "config" ? 'isOneOff' THEN '{}'::jsonb ELSE '{"isOneOff":false}'::jsonb END
WHERE "type" = 'cron'
  AND jsonb_typeof("config") = 'object';--> statement-breakpoint

-- Inbound gained `inputs` and `tokenExpiryDays` (ADR-0030).
UPDATE "trigger"
SET "config" = "config"
  || CASE WHEN "config" ? 'inputs' THEN '{}'::jsonb ELSE '{"inputs":[]}'::jsonb END
  || CASE WHEN "config" ? 'tokenExpiryDays' THEN '{}'::jsonb ELSE '{"tokenExpiryDays":90}'::jsonb END
WHERE "type" = 'inbound'
  AND jsonb_typeof("config") = 'object';--> statement-breakpoint

-- Event configs gained no defaultable field: a missing or empty `events` array
-- cannot be invented, so those rows are reported below.
DO $$
DECLARE
  bad record;
BEGIN
  SELECT id, type INTO bad
  FROM "trigger"
  WHERE type NOT IN ('cron', 'event', 'inbound')
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'trigger config repair: trigger % has unknown type %', bad.id, bad.type;
  END IF;

  SELECT id INTO bad
  FROM "trigger"
  WHERE type = 'cron'
    AND (
      jsonb_typeof(config) IS DISTINCT FROM 'object'
      OR jsonb_typeof(config -> 'cronExpression') IS DISTINCT FROM 'string'
      OR COALESCE(length(config ->> 'cronExpression'), 0) = 0
      OR jsonb_typeof(config -> 'timezone') IS DISTINCT FROM 'string'
      OR jsonb_typeof(config -> 'isOneOff') IS DISTINCT FROM 'boolean'
    )
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'trigger config repair: cron trigger % cannot be repaired', bad.id;
  END IF;

  SELECT id INTO bad
  FROM "trigger"
  WHERE type = 'event'
    AND (
      jsonb_typeof(config) IS DISTINCT FROM 'object'
      OR jsonb_typeof(config -> 'events') IS DISTINCT FROM 'array'
      OR jsonb_array_length(config -> 'events') = 0
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(config -> 'events') = 'array'
            THEN config -> 'events' ELSE '[]'::jsonb END
        ) AS e(name)
        WHERE e.name IS NULL OR e.name NOT IN (
          'notification.created', 'notification.updated',
          'notification.read', 'notification.dismissed',
          'card.created', 'card.updated', 'card.moved', 'card.deleted'
        )
      )
      OR (config ? 'filters' AND jsonb_typeof(config -> 'filters') IS DISTINCT FROM 'object')
      OR (
        jsonb_typeof(config -> 'filters') = 'object'
        AND config -> 'filters' ? 'boardId'
        AND jsonb_typeof(config -> 'filters' -> 'boardId') IS DISTINCT FROM 'string'
      )
      OR (
        jsonb_typeof(config -> 'filters') = 'object'
        AND config -> 'filters' ? 'columnId'
        AND jsonb_typeof(config -> 'filters' -> 'columnId') IS DISTINCT FROM 'string'
      )
      OR (
        jsonb_typeof(config -> 'filters') = 'object'
        AND config -> 'filters' ? 'changedFields'
        AND jsonb_typeof(config -> 'filters' -> 'changedFields') IS DISTINCT FROM 'array'
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(config -> 'filters' -> 'changedFields') = 'array'
            THEN config -> 'filters' -> 'changedFields' ELSE '[]'::jsonb END
        ) AS f(value)
        WHERE jsonb_typeof(f.value) IS DISTINCT FROM 'string'
      )
    )
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'trigger config repair: event trigger % cannot be repaired', bad.id;
  END IF;

  SELECT id INTO bad
  FROM "trigger"
  WHERE type = 'inbound'
    AND (
      jsonb_typeof(config) IS DISTINCT FROM 'object'
      -- Strict: the inbound config accepts no key outside these three.
      OR config - 'inputs' - 'recordKey' - 'tokenExpiryDays' <> '{}'::jsonb
      OR jsonb_typeof(config -> 'inputs') IS DISTINCT FROM 'array'
      OR jsonb_array_length(config -> 'inputs') > 10
      OR jsonb_typeof(config -> 'tokenExpiryDays') IS DISTINCT FROM 'number'
      OR COALESCE(config ->> 'tokenExpiryDays', '') !~ '^(30|90|180|365)$'
      OR (config ? 'recordKey' AND jsonb_typeof(config -> 'recordKey') IS DISTINCT FROM 'string')
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(config -> 'inputs') = 'array'
            THEN config -> 'inputs' ELSE '[]'::jsonb END
        ) AS i(input)
        WHERE jsonb_typeof(i.input) IS DISTINCT FROM 'object'
          OR jsonb_typeof(i.input -> 'name') IS DISTINCT FROM 'string'
          OR (i.input ->> 'name') !~ '^[A-Za-z_][A-Za-z0-9_]*$'
          OR length(i.input ->> 'name') > 64
          OR (i.input ? 'required' AND jsonb_typeof(i.input -> 'required') IS DISTINCT FROM 'boolean')
          OR (i.input ? 'description' AND (
            jsonb_typeof(i.input -> 'description') IS DISTINCT FROM 'string'
            OR length(i.input ->> 'description') > 500
          ))
      )
      OR (
        SELECT count(*) <> count(DISTINCT input ->> 'name')
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(config -> 'inputs') = 'array'
            THEN config -> 'inputs' ELSE '[]'::jsonb END
        ) AS i(input)
      )
      OR (
        config ? 'recordKey'
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(config -> 'inputs') = 'array'
              THEN config -> 'inputs' ELSE '[]'::jsonb END
          ) AS i(input)
          WHERE i.input ->> 'name' = config ->> 'recordKey'
            AND i.input -> 'required' = 'true'::jsonb
        )
      )
    )
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'trigger config repair: inbound trigger % cannot be repaired', bad.id;
  END IF;
END $$;--> statement-breakpoint

-- A closed set of Trigger types, and the closed sets the other string columns
-- were already casting to.
ALTER TABLE "trigger" DROP CONSTRAINT IF EXISTS "trigger_type_allowed", ADD CONSTRAINT "trigger_type_allowed" CHECK ("trigger"."type" in ('cron', 'event', 'inbound'));--> statement-breakpoint
ALTER TABLE "chat" DROP CONSTRAINT IF EXISTS "chat_status_allowed", ADD CONSTRAINT "chat_status_allowed" CHECK ("chat"."status" in ('running', 'succeeded', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "trigger_run" DROP CONSTRAINT IF EXISTS "trigger_run_status_allowed", ADD CONSTRAINT "trigger_run_status_allowed" CHECK ("trigger_run"."status" in ('pending', 'running', 'success', 'failed', 'cancelled', 'suppressed'));--> statement-breakpoint
ALTER TABLE "trigger_run" DROP CONSTRAINT IF EXISTS "trigger_run_event_type_allowed", ADD CONSTRAINT "trigger_run_event_type_allowed" CHECK ("trigger_run"."event_type" is null or "trigger_run"."event_type" in ('notification.created', 'notification.updated', 'notification.read', 'notification.dismissed', 'card.created', 'card.updated', 'card.moved', 'card.deleted'));--> statement-breakpoint
ALTER TABLE "trigger_run_event" DROP CONSTRAINT IF EXISTS "trigger_run_event_type_allowed", ADD CONSTRAINT "trigger_run_event_type_allowed" CHECK ("trigger_run_event"."type" in ('tool-call', 'tool-input', 'reasoning', 'text', 'delegate'));--> statement-breakpoint
ALTER TABLE "trigger_run_event" DROP CONSTRAINT IF EXISTS "trigger_run_event_status_allowed", ADD CONSTRAINT "trigger_run_event_status_allowed" CHECK ("trigger_run_event"."status" in ('running', 'completed', 'error', 'cancelled'));--> statement-breakpoint
ALTER TABLE "organization" DROP CONSTRAINT IF EXISTS "organization_inbound_trigger_gate_allowed", ADD CONSTRAINT "organization_inbound_trigger_gate_allowed" CHECK ("organization"."inbound_trigger_gate" in ('off', 'all', 'selected'));--> statement-breakpoint
ALTER TABLE "organization" DROP CONSTRAINT IF EXISTS "organization_a2a_gate_allowed", ADD CONSTRAINT "organization_a2a_gate_allowed" CHECK ("organization"."a2a_gate" in ('off', 'all', 'selected'));--> statement-breakpoint
ALTER TABLE "organization" DROP CONSTRAINT IF EXISTS "organization_skill_import_gate_allowed", ADD CONSTRAINT "organization_skill_import_gate_allowed" CHECK ("organization"."skill_import_gate" in ('off', 'all', 'selected'));--> statement-breakpoint
ALTER TABLE "organization_member" DROP CONSTRAINT IF EXISTS "organization_member_role_allowed", ADD CONSTRAINT "organization_member_role_allowed" CHECK ("organization_member"."role" in ('admin', 'member'));--> statement-breakpoint

-- A Scoped resource lives at exactly one scope (ADR-0007).
ALTER TABLE "provider" DROP CONSTRAINT IF EXISTS "provider_scope_exclusive", ADD CONSTRAINT "provider_scope_exclusive" CHECK (("provider"."organization_id" is null) <> ("provider"."workspace_id" is null));--> statement-breakpoint
ALTER TABLE "agent" DROP CONSTRAINT IF EXISTS "agent_scope_exclusive", ADD CONSTRAINT "agent_scope_exclusive" CHECK (("agent"."organization_id" is null) <> ("agent"."workspace_id" is null));--> statement-breakpoint
ALTER TABLE "mcp" DROP CONSTRAINT IF EXISTS "mcp_scope_exclusive", ADD CONSTRAINT "mcp_scope_exclusive" CHECK (("mcp"."organization_id" is null) <> ("mcp"."workspace_id" is null));--> statement-breakpoint
ALTER TABLE "skill" DROP CONSTRAINT IF EXISTS "skill_scope_exclusive", ADD CONSTRAINT "skill_scope_exclusive" CHECK (("skill"."organization_id" is null) <> ("skill"."workspace_id" is null));
