-- Custom SQL migration file, put your code below! --

-- Mint a redemption token for every existing invitation row (#549, ADR-0019).
--
-- `token` is nullable at the column level only so this backfill can be a
-- plain data migration; every insert going forward sets it explicitly (the
-- create handler mints it with the same generator used for row ids). This
-- statement fills in the rows that predate that change, so the unique
-- constraint added in 0069 never blocks a legitimate new token, and so a
-- future "copy link" action has something to copy on pre-existing rows too.
--
-- Uses gen_random_uuid()::text rather than the application's id generator,
-- matching the precedent already set by 0040_backfill_org_attachments.sql
-- for the same reason: this runs in SQL, not JS. A v4 UUID carries ~122 bits
-- of entropy and is URL-safe, which is what a backfilled token needs to be;
-- it does not need to be byte-for-byte the same alphabet as a freshly
-- created invitation's token to be an unguessable link.
--
-- Idempotent: a second run's WHERE clause matches nothing, because every row
-- it touched is no longer NULL.
UPDATE "invitation"
SET "token" = gen_random_uuid()::text
WHERE "token" IS NULL
  AND "status" = 'pending'
  AND "expires_at" > now();