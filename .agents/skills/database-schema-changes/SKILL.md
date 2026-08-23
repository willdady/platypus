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
entirely, so a hand-written backfill is invisible until production. Apply the
equivalent change to your own database by hand and say so on the PR.

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
