# Patches

Dependency patches applied by `pnpm install` (registered under
`pnpm.patchedDependencies` in the root `package.json`). Each entry says why the
patch exists and when to drop it.

## `drizzle-kit@0.31.11.patch`

**Fixes:** `pnpm drizzle-kit-push` asking "Do you want to truncate <table>?" on
every run, and silently dropping and re-adding `NULLS NOT DISTINCT` unique
constraints, against a database that already matches the schema.

**Cause:** drizzle-kit's Postgres push introspection reads constraint columns
from `information_schema.constraint_column_usage`, which has no column order,
so a multi-column `unique()` reads back in a different order than the schema
declares it and looks changed. The same code hardcodes
`nullsNotDistinct: false`. The patch orders columns by
`key_column_usage.ordinal_position` and reads `pg_index.indnullsnotdistinct`.

Only `push` is affected; `generate` and production migrations don't introspect.

**Upstream:** [drizzle-orm#5955](https://github.com/drizzle-team/drizzle-orm/issues/5955)
(truncate prompt), [#5879](https://github.com/drizzle-team/drizzle-orm/issues/5879)
(`NULLS NOT DISTINCT`), [#6193](https://github.com/drizzle-team/drizzle-orm/issues/6193)
(same bug for composite primary keys; maintainers say it's fixed in the v1
release candidate). No fixed `0.31.x` release exists.

**Drop when:** upgrading drizzle-kit (the patch is pinned to `0.31.11` and won't
apply to another version). After upgrading, run `pnpm drizzle-kit-push` twice
against an up-to-date database; the second run must print "No changes
detected". If it doesn't, re-create the patch for the new version.
