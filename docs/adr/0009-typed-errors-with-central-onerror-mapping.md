---
status: accepted
---

# Domain code throws typed errors; one `app.onError` maps them to HTTP status

Cross-cutting failure modes — a resource that does not exist, an Organization-scoped
(Shared) **Scoped resource** that is locked against Workspace-surface mutation, and a
unique-constraint violation — are raised as typed errors (`NotFoundError`, `LockedError`,
`ConflictError`) from services and route handlers, and mapped to HTTP status in a single
Hono `app.onError` handler (`NotFound → 404`, `Locked → 403`, `Conflict → 409`). This
replaces the prior pattern where every route returned `c.json({ error }, status)` inline
and each create/update route hand-rolled its own Postgres unique-violation detection.

The motivating change is the `ScopedResource` read module (`services/scoped-resource.ts`):
its `requireScoped` / `requireWorkspaceMutable` entry points throw `NotFoundError` /
`LockedError` so the ~5 dual-scope resource routes stop re-implementing the
"resolve → null-check → org-scope-403" branch. Pure `resolveScoped` / `listScoped`
remain exception-free for callers that tolerate absence.

## Considered Options

- **Status quo — inline `c.json({ error }, status)` per route.** Rejected: the
  visibility-resolution, lock, and uniqueness responses were duplicated across ~8 route
  files (notably 8 byte-identical copies of `isUniqueViolation`), with no single place to
  fix the message or the status.
- **A shared helper returning a discriminated result the route branches on** (no throw).
  Rejected: keeps the branch at every call site; the route still has to translate the
  result into a response. The win is partial — locality of the _decision_ without locality
  of the _response_.
- **Throw only `LockedError` + `NotFoundError`; leave uniqueness per-route.** Rejected:
  once a central `onError` exists, folding the unique-violation mapping in deletes all 8
  copies for one extra mapping line — the larger blast radius (touching each create/update
  catch block) is the point of the refactor, not a reason to stop short.

## Consequences

- New module `apps/backend/src/errors.ts` holds the typed error classes; a single
  `app.onError` in the server entry maps them, including a catch for Postgres unique
  violations (SQLSTATE `23505` across driver shapes) → `409`.
- Routes that currently `return c.json({ error }, status)` for these three cases are
  migrated to throw (or to let the module's throw propagate). Other, route-specific 4xx
  responses (validation, sub-agent rules, `findNonSharedReferences`) stay inline — only the
  three cross-cutting modes move to the seam.
- The keys-only / message conventions for the lock response (`"managed at the organization
level"`) and name conflicts move into `onError`, so they are defined once.
- `resolveScoped` and `listScoped` deliberately do **not** throw, preserving a pure,
  reusable predicate for callers (e.g. the Chat-turn attachment check) that treat absence
  as a normal outcome rather than a 404.
- Authorization is unchanged: middleware still decides actor access and returns its own
  403s inline. The error seam covers resource-state failures, not authorization.
