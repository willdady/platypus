---
name: api-conventions
description: Response-body conventions for the Platypus backend API — the `error` key for failures, the `message` key for 2xx status messages, and when to throw a typed error instead of returning a response. Use when adding or changing a backend route or its tests.
---

# API Response Conventions

## The two keys

`error` carries a failure. `message` carries a 2xx status line for an
operation that has no resource to return.

```typescript
return c.json({ error: "Workspace not found" }, 404);
return c.json({ message: "Board deleted" });
```

Never `message` on a 4xx/5xx — that is the one crossing the codebase does not
make.

## The error seam

Four cross-cutting failures are **thrown**, not returned. A single `onError`
seam maps each to its status and emits the same `{ error }` body, so a domain
rule states its message once instead of once per caller:

| Throw             | Becomes |
| ----------------- | ------- |
| `NotFoundError`   | 404     |
| `ValidationError` | 400     |
| `LockedError`     | 403     |
| `ConflictError`   | 409     |

A Postgres unique violation also maps to 409 — detect it through the shared
helper rather than re-reading the driver's error shape.

```typescript
if (!row) throw new NotFoundError("Card not found");
throw new ValidationError("Invalid user assignee");
```

Throwing is what lets one rule serve more than one surface: the Kanban rules
answer both the HTTP routes and the Agent tool set from a single place. Reach
for the seam whenever the failure is one of those four; a 4xx that only one
route can produce still answers inline with `c.json({ error }, status)`. Both
are current and roughly equally common — the seam is not a migration you
should finish.

## Test assertions

Assert against the key the response actually uses:

```typescript
expect(body.error).toBe("Invalid user assignee");
expect(await res.json()).toEqual({ message: "Board deleted" });
```

A service test covering a thrown failure asserts the error, not a body:

```typescript
await expect(fn()).rejects.toThrow(NotFoundError);
```
