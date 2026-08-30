-- Custom SQL migration file, put your code below! --

-- Lower-case existing invitation email addresses (issue #548).
--
-- The create handler stored the address exactly as the Org Admin typed it,
-- while better-auth lower-cases `user.email` on sign-up. Every read matches
-- `invitation.email` with an exact equality predicate, so a row created for
-- `Bob@Example.com` can never match the user row `bob@example.com`: the invitee
-- sees nothing, the admin's table shows it `pending` forever, and neither side
-- is told. The handler now normalizes at the write; this repairs the rows that
-- were stored before that.
--
-- The fold cannot be unconditional. `unique_invitation_org_email` covers
-- (organization_id, email), so an organization holding both `Bob@x.com` and
-- `bob@x.com` would raise 23505 mid-migration — and scripts/migrate.ts exits 1
-- on failure, which would fail the upgrade precisely on the deployments this
-- migration exists to repair. So only rows that cannot collide are folded:
-- at most one per (organization_id, lower(email)) group, and only when no other
-- row in that organization already holds the lower-cased form.
--
-- Where a group does collide, the newest invitation is the one folded — it
-- carries the latest intent and the most remaining time before expiry. Its
-- mixed-case siblings are left exactly as they are: still pending, still
-- invisible, unchanged by this migration. De-duplicating them is out of scope
-- (#548) — two pending invitations for one person is pre-existing behaviour.
--
-- Idempotent: a second run matches nothing, because every row it folded is now
-- lower-case and every row it skipped still finds a lower-case sibling.
--
-- NB: `drizzle-kit push` (the dev workflow) does NOT execute migration files,
-- so this does not run in dev. Verify against a manually seeded row.
WITH winners AS (
  SELECT DISTINCT ON ("organization_id", lower("email")) "id"
  FROM "invitation"
  WHERE "email" <> lower("email")
  ORDER BY "organization_id", lower("email"), "created_at" DESC, "id"
)
UPDATE "invitation" i
SET "email" = lower(i."email")
FROM winners w
WHERE i."id" = w."id"
  AND NOT EXISTS (
    SELECT 1
    FROM "invitation" j
    WHERE j."organization_id" = i."organization_id"
      AND j."email" = lower(i."email")
      AND j."id" <> i."id"
  );
