## Project Overview

Platypus is a full-stack app for building and managing AI agents with tool support and multi-provider capabilities. pnpm workspaces + Turborepo monorepo.

## Setup & Commands

```bash
pnpm install
cp apps/frontend/.env.example apps/frontend/.env
cp apps/backend/.env.example apps/backend/.env

pnpm dev               # frontend + backend + local Postgres
pnpm drizzle-kit-push  # apply schema changes (requires `pnpm dev` running)
pnpm build
pnpm format
pnpm lint
pnpm typecheck         # tsc --noEmit (apps/backend, apps/frontend); gated in CI
pnpm test              # all tests (Vitest, orchestrated by Turborepo)
```

Per-package: `pnpm --filter <pkg> test|test:watch|test:coverage|typecheck`.

`pnpm typecheck` runs `tsc --noEmit` for every package exposing a `typecheck`
script (currently `apps/backend` and `apps/frontend`). CI fails on any type
error — ESLint does not catch them, so run it before pushing. Other packages
join the gate by adding their own `typecheck` script.

Default admin on first startup: `admin@example.com` / `admin123` (override via `ADMIN_EMAIL` / `ADMIN_PASSWORD`).

## Monorepo Layout

- **`apps/backend`** — Hono.js REST API, Drizzle ORM (Postgres 17), better-auth at `/auth/*`. Schema in `src/db/`, routes in `src/routes/`, run lifecycle in `src/runs/`. Entry: `apps/backend/index.ts`.
- **`apps/frontend`** — Next.js 16 App Router. Multi-tenant routes under `app/[orgId]/workspace/[workspaceId]/...`. Tailwind v4 + Radix.
- **`packages/schemas`** — Shared Zod schemas (`@platypus/schemas`). Each domain model has full / create / update variants.

Domain hierarchy: **Organization → Workspace → Chat / Agent / MCP / Provider**.

## Known Constraints

- **`drizzle-kit push` applies DDL only — it does NOT run migration `.sql` files.** Data
  migrations (e.g. custom backfills) run in production via `scripts/migrate.ts` (`drizzle-kit
migrate`) but are skipped by the dev push flow. In dev, apply any needed data changes manually
  (e.g. attach org-scoped Shared resources via the UI).
- **Postgres 18 is not supported** (Drizzle ORM incompatibility).
- **No TypeScript parameter properties.** Node's strip-only TS mode rejects `constructor(private x: T)` shorthand. Declare fields explicitly and assign in the constructor body.
- Format with Prettier conventions.

## Documentation

Docs live in `apps/docs/content` and ship **in the same PR as the code**, never
as a follow-up ticket. The follow-up ticket does not get filed; that is how
`627cb1e` shipped a breaking Operator-facing change with no docs update.

Check the table below against the paths in your own diff. If they intersect,
the docs edit is part of this change:

| You changed                                              | Update                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| any `.env.example`                                       | `reference/backend-configuration.mdx` / `frontend-configuration.mdx` |
| a user-facing `min`/`max`/`z.enum` in `packages/schemas` | the matching `building-with-platypus/*.mdx` page                     |
| `apps/backend/src/plugins/**`                            | `extending/index.mdx`, `self-hosting/configuration.mdx`              |
| a visible label, field, or nav item in `apps/frontend`   | the `building-with-platypus/*.mdx` page for that feature             |

When writing:

- The audience is self-hosters and Workspace Owners, not maintainers.
- Write the task, not the implementation — no `apps/**` paths, no ADR links, no
  inlined interfaces, no status sections.
- House style is `.agents/skills/docs-audit/VOICE.md`.

`apps/docs/content/docs-contract.test.ts` mechanically pins the claims with a
single authoritative source (env tables, webhook events, core Plugin names,
field limits, internal links, heading anchors) and runs in the CI gate. It is a
floor, not a gate — it cannot see the ~150 UI labels. For what needs judgement,
ask the user to run `/docs-audit`; the skill is user-invoked only, so you cannot
start it yourself.

## Git Branch Standards

Branch names MUST be prefixed `feature/`, `fix/`, or `chore/` only.

## Git Commit Standards

[Conventional Commits](https://www.conventionalcommits.org/) with **strict types**: only `feat`, `fix`, `chore`. Optional scope in parens.

```
feat(backend): add JWT refresh
fix(frontend): correct workspace navigation
chore: update dependencies
```

## Git PR Standards

**The PR title MUST be a Conventional Commit subject** — same strict types as above.
`main` squash-merges with the PR title as the commit subject, so the title is what
ends up in history; the individual commit subjects on the branch are discarded.

Titling the PR correctly is the whole of it, and it matters more than it looks:

- release-please builds the changelog and the version bump **only** from Conventional
  Commit subjects on `main`. A PR titled `Add web search` merges as a commit release-please
  cannot read, so the feature ships with no changelog entry and no minor bump.
- `main` is protected, so a subject that lands wrong can only be corrected by rewriting
  published history. Getting the title right costs nothing; fixing it later costs a
  force-push.

Set the title when you open the PR, and re-check it before requesting a merge — `gh pr
edit <n> --title "..."` if it drifted. This applies to a PR whose body already explains
the change: the body is for humans, the title is for the release machinery.

## Agent Skills

- **Issue tracker** — GitHub issues on `willdady/platypus` via `gh`. See `docs/agents/issue-tracker.md`.
- **Triage labels** — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.
- **Domain docs** — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
