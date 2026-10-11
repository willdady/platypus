---
name: database-schema-changes
description: Guide for making database schema changes in Platypus using Drizzle ORM — editing the schema, pushing to a dev database, and generating the migration that ships.
---

# Database Schema Changes

**Push is for your machine; generate is what ships.** Both, every time. A push
with no generate leaves a dev database that works and a production deploy that
never receives the change — and nothing local tells you, because your own
database is already correct.

## Steps

1. **Edit the schema** — the backend's Drizzle schema module, where the tables
   are declared.

2. **Push it to your dev database.** Needs `pnpm dev` up, since the push talks
   to a live Postgres:

   ```bash
   pnpm drizzle-kit-push
   ```

3. **Generate the migration.** Production applies numbered `.sql` migrations,
   not your schema file, so this is the step that carries the change out of your
   machine:

   ```bash
   pnpm drizzle-kit-generate
   ```

**Done when** `git status` shows three new or modified artefacts beside your
schema edit: a numbered `.sql` migration, its snapshot, and an appended journal
entry. All of them are committed, in the same commit as the schema change.

## Data changes

Generate writes DDL — it reads your schema and diffs it. A backfill, a
re-shaping of existing rows, or anything else that needs to *reason* about data
is yours to write into the generated migration by hand.

Dev never runs it: the push flow applies DDL only and skips migration files
entirely, so a hand-written backfill is invisible until production. Run the
migration file against the dev container (`apps/backend/scripts/start_postgres.sh`
names it and its credentials):

```bash
docker exec -i platypus-postgres psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -1 < apps/backend/drizzle/<tag>.sql
```

The PR body states that the migration carries a data step `push` skips, so
every reviewer knows to apply it to their own database.

## Migration number collisions

Main gained a migration with your number since you generated (parallel
branches each generate the next free number). The fix is regeneration, not
hand-renumbering: take main's migrations, discard your generated `.sql`,
snapshot and journal entry, and run step 3 again. Copy any hand-written data
SQL into the new file, and update tests that name the migration tag.

When both migrations are unreleased and you are integrating the branches
yourself, combining them into one is cleaner than stacking two:

- one `.sql` holding both changes, statements separated by
  `--> statement-breakpoint`, named for both;
- the snapshot from whichever side has DDL (data-only migrations change none);
- one journal entry carrying the combined tag.

**Done when** the newest snapshot's `prevId` equals the previous snapshot's
`id`, and `pnpm drizzle-kit-generate` prints "No schema changes".

## Auth tables

better-auth owns the auth tables — do not hand-edit that generated schema. When
you change the auth configuration, regenerate it, then treat the result as a
normal schema change and continue from step 2:

```bash
pnpm --dir apps/backend dlx @better-auth/cli@latest generate \
  --config ./src/auth.ts --output ./src/db/auth-schema.ts --yes
```

(The paths inside that command are arguments the CLI needs, not references to
look up.)

The CLI rewrites the whole file and can revert unrelated defaults (seen with
`role` and `updatedAt`). Diff the result and keep only the lines your change
needs.
