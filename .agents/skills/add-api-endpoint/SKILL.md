---
name: add-api-endpoint
description: Guide for adding new API endpoints to the Platypus backend using Hono.js — routing, tenant scoping middleware, validation, and database access.
---

# Adding New API Endpoints

**Authenticated is not scoped.** `requireAuth` proves who the caller is and
nothing about what they may reach. Platypus is multi-tenant — Organization →
Workspace → resource — so an endpoint carrying only `requireAuth` is reachable
by any logged-in user against any tenant's data. Scope is a separate,
mandatory decision, taken per route.

## Steps

1. **Create the route module** in the backend's routes area — a `Hono` instance
   exported for mounting.

2. **Mount it on the app** in the backend's server module. The mount path
   carries the tenancy, so the hierarchy lives in the URL and the middleware
   reads the ids from it:

   ```typescript
   app.route("/organizations/:orgId/workspaces/:workspaceId/agents", agent);
   ```

3. **Define the request schemas** in the shared schemas package, following the
   full / create / update variants each domain model already has.

4. **Compose each route**: authenticate, scope, validate, handle — in that
   order, as arguments to the route, not as a blanket `.use("*")`. Scope is per
   route because two routes in one file rarely deserve the same access.

   ```typescript
   agent.post(
     "/",
     requireAuth,
     requireOrgAccess(),
     requireWorkspaceAccess,
     sValidator("json", agentCreateSchema),
     async (c) => {
       const data = c.req.valid("json");
       const scope = workspaceScopeOf(c);
       // ...
     },
   );
   ```

**Done when** every route in the module names its scoping middleware
explicitly, and you can say which tenant each one is confined to.

## Choosing the scope

Pick the narrowest that admits the callers you intend:

| Middleware                           | Admits                                                    |
| ------------------------------------ | --------------------------------------------------------- |
| `requireOrgAccess()`                 | any member of the Organization in the path                |
| `requireOrgAccess(["admin"])`        | members holding one of the named Organization roles       |
| `requireWorkspaceAccess`             | callers permitted in the Workspace in the path            |
| `requireWorkspaceOwner`              | the Workspace's Owner                                     |
| `requireWorkspaceConfigAccess()`     | credential- or reach-bearing Workspace config, admin-only |
| `requireWorkspaceConfigAccess(flag)` | the same, plus the Owner when that Workspace flag is set  |
| `requireSuperAdmin`                  | platform operators only                                   |

Org and Workspace scoping compose — the Workspace check assumes the Org check
ran ahead of it. Super admins bypass the Org membership check by design, so a
route may legitimately resolve with no Organization to scope to.

Read the resolved scope through the scope accessors (`workspaceScopeOf`,
`orgScopeOf`) rather than re-reading path params: the accessor hands you the
scope the middleware already decided, so the query cannot disagree with the
authorization.

## Database access

Import the shared `db` instance from the backend entry module, the way the
route modules already do, and query it with Drizzle. The request context also
carries a `db`, but that is a narrow exception rather than the house pattern.

Never scope a query by a raw path param. Take the tenant ids from the resolved
scope, so an unscoped read cannot be written by accident.

## Responses

Response body shape — the `error` key, the `message` key, and when to throw a
typed error instead of returning one — is covered by the `api-conventions`
skill. Load it rather than inventing a shape.
