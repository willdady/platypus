-- Custom SQL migration file, put your code below! --

-- Move every Chat's `messages` array into `chat_message` rows (ADR-0026, #711).
--
-- Each array becomes a chain: a message's parent is the message before it, and
-- the Chat's `active_leaf_id` is the last one. `created_at` is the Chat's own
-- plus one millisecond per position, so the rows keep the array's order. A Chat
-- whose `messages` is null or empty gets no rows and keeps a null leaf.
--
-- Two elements in a row with the same id are an artifact of the #649 mid-flush
-- bug, which wrote a trailing assistant message twice. The later one is the
-- fuller continuation, so it is kept and the earlier one dropped.
--
-- Anything else malformed stops the migration and names the Chat. Nothing is
-- skipped, coerced or repaired: a transcript that cannot be moved faithfully
-- is for a human to look at, not for the upgrade to guess about.
--
-- `drizzle-kit push` does not run this file. A dev database needs
-- `pnpm drizzle-kit-migrate`, or its transcripts are lost when 0073 drops the
-- column.
DO $$
DECLARE
  bad record;
BEGIN
  SELECT c.id INTO bad
  FROM chat c
  WHERE jsonb_typeof(c.messages) NOT IN ('array', 'null')
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'chat_message backfill: chat % has messages that are not an array', bad.id;
  END IF;

  SELECT c.id, e.ord INTO bad
  FROM chat c,
    jsonb_array_elements(
      CASE WHEN jsonb_typeof(c.messages) = 'array' THEN c.messages ELSE '[]' END
    ) WITH ORDINALITY AS e(msg, ord)
  WHERE jsonb_typeof(e.msg) IS DISTINCT FROM 'object'
    OR jsonb_typeof(e.msg -> 'id') IS DISTINCT FROM 'string'
    OR (e.msg ->> 'role') NOT IN ('user', 'assistant')
    OR (e.msg ->> 'role') IS NULL
    OR jsonb_typeof(e.msg -> 'parts') IS DISTINCT FROM 'array'
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'chat_message backfill: chat % has a malformed message at position %', bad.id, bad.ord;
  END IF;

  -- A duplicate that survives collapsing the adjacent runs.
  SELECT kept.chat_id, kept.id INTO bad
  FROM (
    SELECT c.id AS chat_id, e.msg ->> 'id' AS id,
      lead(e.msg ->> 'id') OVER (PARTITION BY c.id ORDER BY e.ord) AS next_id
    FROM chat c,
      jsonb_array_elements(
        CASE WHEN jsonb_typeof(c.messages) = 'array' THEN c.messages ELSE '[]' END
      ) WITH ORDINALITY AS e(msg, ord)
  ) kept
  WHERE kept.next_id IS DISTINCT FROM kept.id
  GROUP BY kept.chat_id, kept.id
  HAVING count(*) > 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'chat_message backfill: chat % holds message id % more than once', bad.chat_id, bad.id;
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO "chat_message" ("chat_id", "id", "parent_id", "role", "parts", "metadata", "created_at")
SELECT chain.chat_id, chain.msg ->> 'id', chain.parent_id, chain.msg ->> 'role',
  chain.msg -> 'parts', chain.msg -> 'metadata',
  chain.created_at + chain.ord * interval '1 millisecond'
FROM (
  SELECT kept.*,
    lag(kept.msg ->> 'id') OVER (PARTITION BY kept.chat_id ORDER BY kept.ord) AS parent_id
  FROM (
    SELECT c.id AS chat_id, c.created_at, e.msg, e.ord,
      lead(e.msg ->> 'id') OVER (PARTITION BY c.id ORDER BY e.ord) AS next_id
    FROM chat c,
      jsonb_array_elements(
        CASE WHEN jsonb_typeof(c.messages) = 'array' THEN c.messages ELSE '[]' END
      ) WITH ORDINALITY AS e(msg, ord)
  ) kept
  -- Drops the earlier of two adjacent same-id elements (#649, above).
  WHERE kept.next_id IS DISTINCT FROM kept.msg ->> 'id'
) chain;
--> statement-breakpoint
UPDATE "chat" c
SET "active_leaf_id" = leaf.id
FROM (
  SELECT DISTINCT ON ("chat_id") "chat_id", "id"
  FROM "chat_message"
  ORDER BY "chat_id", "created_at" DESC
) leaf
WHERE leaf.chat_id = c.id;
