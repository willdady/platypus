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
pnpm test              # all tests (Vitest, orchestrated by Turborepo)
```

Per-package: `pnpm --filter <pkg> test|test:watch|test:coverage`.

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

## Git Branch Standards

Branch names MUST be prefixed `feature/`, `fix/`, or `chore/` only.

## Git Commit Standards

[Conventional Commits](https://www.conventionalcommits.org/) with **strict types**: only `feat`, `fix`, `chore`. Optional scope in parens.

```
feat(backend): add JWT refresh
fix(frontend): correct workspace navigation
chore: update dependencies
```

## Agent Skills

- **Issue tracker** — GitHub issues on `willdady/platypus` via `gh`. See `docs/agents/issue-tracker.md`.
- **Triage labels** — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.
- **Domain docs** — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
