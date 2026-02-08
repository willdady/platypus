# Authorization Middleware Implementation Plan

## Overview

Apply authorization middleware (`requireOrgAccess`, `requireWorkspaceAccess`) to all backend routes to enforce role-based access control. This includes enhancing the middleware for smart ID detection and adding super admin restrictions.

## User Requirements

1. **Organization creation** - Restrict to super admins only
2. **Chat access for viewers** - Allow all operations (read, create, edit, delete)
3. **Agent deletion** - Admins only (editors can create/update but not delete)
4. **ID resolution** - Smart detection: URL params → query params → request body

## Critical Files

### Middleware

- `apps/backend/src/middleware/authorization.ts` - Enhance ID resolution and add requireSuperAdmin

### Route Files (all in `apps/backend/src/routes/`)

- `organization.ts` - Org-level access control + super admin restriction
- `workspace.ts` - Org-level access control
- `agent.ts` - Workspace-level access control with role restrictions
- `chat.ts` - Workspace-level access control (no role restrictions)
- `provider.ts` - Workspace-level access control (admin-only writes)
- `mcp.ts` - Workspace-level access control (admin-only writes)
- `tool.ts` - Workspace-level access control

## Implementation Steps

### Step 1: Enhance Authorization Middleware

**File:** `apps/backend/src/middleware/authorization.ts`

**Changes:**

1. **Add smart ID detection helper function**

   ```typescript
   // Helper to extract ID from request (URL params → query → body)
   const extractId = (
     c: any,
     paramName: string,
     queryName?: string,
   ): string | undefined => {
     return (
       c.req.param(paramName) ||
       c.req.query(queryName || paramName) ||
       c.req.json?.[queryName || paramName]
     );
   };
   ```

2. **Update `requireOrgAccess` middleware**
   - Replace line 28: `const orgId = c.req.param("orgId") || c.req.query("organizationId");`
   - With: Smart detection that tries multiple sources and variations:
     - URL param: `orgId`, `id` (for /:id routes)
     - Query param: `organizationId`, `orgId`
     - Body: `organizationId`, `orgId`

3. **Update `requireWorkspaceAccess` middleware**
   - Replace line 70: `const workspaceId = c.req.param("workspaceId") || c.req.query("workspaceId");`
   - With: Smart detection for `workspaceId`, `id` from params/query/body

4. **Add `requireSuperAdmin` middleware**

   ```typescript
   export const requireSuperAdmin = createMiddleware(async (c, next) => {
     const user = c.get("user");

     if (!isSuperAdmin(user.email)) {
       return c.json({ error: "Super admin access required" }, 403);
     }

     await next();
   });
   ```

### Step 2: Update Organization Routes

**File:** `apps/backend/src/routes/organization.ts`

**Import additions:**

```typescript
import {
  requireOrgAccess,
  requireSuperAdmin,
} from "../middleware/authorization.ts";
```

**Changes:**

1. **Remove global `requireAuth`** (line 17) - will apply per-route
2. **POST /** - `requireAuth, requireSuperAdmin` (super admin only)
3. **GET /** - `requireAuth` + filter results to user's organizations
   - Query user's org memberships first
   - Return only orgs where user is a member (or all if super admin)
4. **GET /:id** - `requireAuth, requireOrgAccess()`
5. **PUT /:id** - `requireAuth, requireOrgAccess(["admin"])`
6. **DELETE /:id** - `requireAuth, requireOrgAccess(["admin"])`
7. **GET /:orgId/membership** - `requireAuth, requireOrgAccess()`

**Special handling for GET /**:

```typescript
organization.get("/", requireAuth, async (c) => {
  const user = c.get("user")!;
  const db = c.get("db");

  // Super admins see all orgs
  if (isSuperAdmin(user.email)) {
    const results = await db.select().from(organizationTable);
    return c.json({ results });
  }

  // Regular users see only their orgs
  const memberships = await db
    .select({ organizationId: organizationMember.organizationId })
    .from(organizationMember)
    .where(eq(organizationMember.userId, user.id));

  const orgIds = memberships.map((m) => m.organizationId);

  if (orgIds.length === 0) {
    return c.json({ results: [] });
  }

  const results = await db
    .select()
    .from(organizationTable)
    .where(inArray(organizationTable.id, orgIds));

  return c.json({ results });
});
```

### Step 3: Update Workspace Routes

**File:** `apps/backend/src/routes/workspace.ts`

**Import additions:**

```typescript
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
```

**Changes:**

1. **Remove global `requireAuth`** (line 17)
2. **POST /** - `requireAuth, requireOrgAccess(["admin"])`
3. **GET /** - `requireAuth, requireOrgAccess()`
4. **GET /:id** - `requireAuth, requireOrgAccess()`
5. **PUT /:id** - `requireAuth, requireOrgAccess(["admin"])`
6. **DELETE /:id** - `requireAuth, requireOrgAccess(["admin"])`
7. **GET /:workspaceId/membership** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess()`

**Note:** Current logic queries by `organizationId` query param, middleware will validate access.

### Step 4: Update Agent Routes

**File:** `apps/backend/src/routes/agent.ts`

**Import additions:**

```typescript
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
```

**Changes:**

1. **Remove global `requireAuth`** (line 16)
2. **POST /** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess(["admin", "editor"])`
3. **GET /** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess()`
4. **GET /:id** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess()`
5. **PUT /:id** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess(["admin", "editor"])`
6. **DELETE /:id** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess(["admin"])` (admin only per user requirement)

**Note:** Routes query by `workspaceId` param, middleware will validate.

### Step 5: Update Chat Routes

**File:** `apps/backend/src/routes/chat.ts`

**Import additions:**

```typescript
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
```

**Changes:**

1. **Remove global `requireAuth`** (line 389)
2. **Apply to all routes:** `requireAuth, requireOrgAccess(), requireWorkspaceAccess()`
   - GET / - List chats
   - GET /tags - Get tags
   - GET /:id - Get chat
   - POST / - Create/stream chat
   - DELETE /:id - Delete chat
   - PUT /:id - Update chat
   - POST /:id/generate-metadata - Generate metadata

**Note:** No role restrictions - viewers can do everything per user requirement.

### Step 6: Update Provider Routes

**File:** `apps/backend/src/routes/provider.ts`

**Import additions:**

```typescript
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
```

**Changes:**

1. **Remove global `requireAuth`** (line 15)
2. **POST /** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess(["admin"])` (admin only, has API keys)
3. **GET /** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess()`
4. **GET /:id** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess()`
5. **PUT /:id** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess(["admin"])`
6. **DELETE /:id** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess(["admin"])`

**Rationale:** Providers contain sensitive API keys, only admins should manage them.

### Step 7: Update MCP Routes

**File:** `apps/backend/src/routes/mcp.ts`

**Import additions:**

```typescript
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
```

**Changes:**

1. **Remove global `requireAuth`** (line 19)
2. **POST /** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess(["admin"])`
3. **GET /** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess()`
4. **GET /:id** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess()`
5. **PUT /:id** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess(["admin"])`
6. **DELETE /:id** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess(["admin"])`
7. **POST /test** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess(["admin"])`

**Rationale:** MCPs contain sensitive auth tokens, only admins should manage them.

### Step 8: Update Tool Routes

**File:** `apps/backend/src/routes/tool.ts`

**Import additions:**

```typescript
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
```

**Changes:**

1. **Remove global `requireAuth`** (line 14)
2. **GET /** - `requireAuth, requireOrgAccess(), requireWorkspaceAccess()`

**Note:** Tool list combines static tools + workspace MCPs, needs workspace validation.

## Implementation Order

1. **Step 1** - Enhance middleware (foundation for everything else)
2. **Step 2** - Organization routes (includes critical security fix for GET /)
3. **Step 3** - Workspace routes (org-scoped, no workspace dependency)
4. **Step 4-8** - Workspace-scoped resources (agent, chat, provider, mcp, tool) - can be done in parallel

## Testing Approach

For each route file after changes:

1. **Super Admin Test** - Verify super admin can access everything
2. **Org Admin Test** - Verify org admin can manage org resources and auto-access workspaces
3. **Org Member Test** - Verify member needs explicit workspace membership
4. **Workspace Role Test** - Verify editor/viewer restrictions work correctly
5. **Unauthorized Test** - Verify 403 errors for insufficient permissions
6. **ID Resolution Test** - Verify middleware extracts IDs from params, query, and body

## Edge Cases & Considerations

1. **Organization GET /** - Returns empty array if user has no org memberships (not an error)
2. **Resource ownership validation** - Middleware only checks org/workspace membership, not resource ownership
3. **Cascading deletes** - Deleting an org/workspace will cascade to all child resources
4. **Missing IDs** - Middleware returns 400 if required IDs not found in request
5. **Super admin bypass** - Super admins skip all membership checks via environment variable
6. **Middleware ordering** - Always: requireAuth → requireOrgAccess → requireWorkspaceAccess → route handler

## Security Improvements

This implementation addresses these critical security issues:

1. **Organization leak** - Fixed GET / to filter by user membership
2. **Workspace scope bypass** - All workspace resources now validate access
3. **Sensitive data exposure** - Provider/MCP write operations restricted to admins
4. **Role enforcement** - Agent deletion restricted to admins only
5. **Smart ID detection** - Prevents bypassing via alternative parameter locations

## Rollback Plan

If issues arise:

1. Middleware changes are backwards compatible (existing behavior preserved)
2. Each route file can be reverted independently
3. Super admin restriction on org creation can be removed if too restrictive
4. Role requirements can be relaxed if too strict

## Success Criteria

- [ ] All routes have appropriate authorization middleware
- [ ] Super admins can access all resources
- [ ] Org admins can manage org resources and auto-access workspaces
- [ ] Workspace role restrictions work correctly (admin/editor/viewer)
- [ ] Organization GET / returns only user's organizations
- [ ] Provider/MCP management restricted to admins
- [ ] Agent deletion restricted to admins
- [ ] Smart ID detection works from params, query, and body
- [ ] Unauthorized access returns 403 with clear error messages
- [ ] No regression in existing functionality
