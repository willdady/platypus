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

## Amendment — `ValidationError` → 400 (#478)

A fourth class, `ValidationError`, was added when the Kanban board's rules moved into one
module (`services/kanban.ts`) serving both the HTTP routes and the Agent Tool set. A rule
with two callers cannot answer with one caller's response shape, so it throws: the route
lets `onError` map it to 400, and the Tool adapter turns it into its `{ error }` result.

This narrows, but does not reverse, "validation stays inline" above. Validation that
belongs to a single surface still answers inline; only a rule shared by more than one
surface earns the seam.

## Amendment — the org/workspace access _decision_ moves behind an interface (#499)

"Authorization is unchanged: middleware still decides actor access and returns its own
403s inline" above is narrowed, not reversed. `requireOrgAccess` and
`requireWorkspaceAccess` (`middleware/authorization.ts`) fused the membership/workspace
query, the JS-side ownership branch, and the `c.json({ error }, status)` write into one
function — the same query-and-branch-and-respond shape `workspaceConfigAccess` had
already moved past, returning `{ allowed } | { allowed: false, reason }` instead.

The query and the branch are now `resolveOrgMembership` / `resolveWorkspaceAccess`: pure
functions returning the same `{ allowed, membership }` / `{ allowed, isWorkspaceOwner }`
or `{ allowed: false, reason }` shape `workspaceConfigAccess` uses, unit-tested against an
in-memory fake executor built on real `eq`/`and` conditions rather than the route suite's
no-op-operator mock. Where the
403 (or the cross-org 404) is written stays in the middleware, which now only maps a
`reason` to a status and message — so the line above still holds: middleware, not a
service or the error seam, is what answers the caller.

This is the same move `workspaceConfigAccess` made, not a new one — the amendment
records it as one case, not two independent decisions.

## Amendment — `FileValidationError` → 400 with `files` (#501)

The Chat-turn path had drifted from this ADR: `chat-execution.ts` carried its own
module-private `NotFoundError`/`ValidationError` (name-identical to, but a different class
from, the ones here), invisible to `mapError`, so only the chat route's own `try`/`catch`
kept them working — any other caller of `prepareChatTurn` (a future Gateway or Trigger)
would have gotten a 500 from this seam instead of the right status. `file-gate.ts`'s
`FileValidationError` was similarly kept standalone with a comment blaming an import cycle
that importing it into `mapError` (rather than the reverse) does not have.

The fix restores the seam rather than special-casing around it: `chat-execution.ts` now
throws this module's `NotFoundError`/`ValidationError`, and `mapError` gained a
`FileValidationError` case. `FileValidationError` itself stays defined in `file-gate.ts` — it
groups `FileRejection`s (a file-domain type) into its message, which this module has no
reason to know about — but `mapError`'s return grew an optional `files` field so the one
`app.onError` can still carry it through. The chat route's `try`/`catch` is gone; every
`prepareChatTurn` caller now gets the same status codes.
