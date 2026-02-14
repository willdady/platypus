# Plan 13: Single-User Workspaces

## Goal

Change workspaces from shared multi-user entities to single-user owned entities. Each workspace belongs to exactly one user. Users are invited to organizations (not workspaces) and create their own workspaces within the org.

## Key Decisions

- Workspaces have an `ownerId` column instead of a `workspaceMember` table
- Any org member can create workspaces (not just admins)
- Org admins retain full access to all workspaces for oversight
- Super admins retain full access to everything
- Invitations are simplified to org-only (no workspace selection)
- `workspaceMember` table is removed entirely

---

## Changes

### 1. Database Schema (`apps/backend/src/db/schema.ts`)

- **Add `ownerId`** column to `workspace` table (foreign key to `user.id`, not null)
- **Drop `workspaceMember`** table entirely
- **Remove `workspaceId`** from `invitation` table; update unique constraint to be per org/email instead of per workspace/email
- **Remove `role`** from `invitation` table (no workspace role to assign)

### 2. Shared Schemas (`packages/schemas/index.ts`)

- Remove `workspaceMemberSchema`, `workspaceMemberCreateSchema`, `workspaceMemberUpdateSchema`
- Remove `workspaceId` and `role` from `invitationCreateSchema`
- Remove workspace role references from `invitationListItemSchema`
- Add `ownerId` to `workspaceSchema`
- Remove workspace-related fields from `orgMemberListItemSchema` (the workspaces array showing workspace memberships)
- Clean up any other references to workspace membership/roles

### 3. Authorization Middleware (`apps/backend/src/middleware/authorization.ts`)

- **Rewrite `requireWorkspaceAccess`**:
  - Query workspace to get `ownerId`
  - If user is super admin → admin access
  - If user is org admin → admin access
  - If user is workspace owner (`ownerId === userId`) → admin access
  - Otherwise → 403
  - Remove workspace role hierarchy logic; the only "role" is owner or not
- Remove `workspaceRole` and `workspaceMembership` from Hono context variables (replace with `isWorkspaceOwner` boolean or similar)

### 4. Backend Routes

#### `apps/backend/src/routes/workspace.ts`

- **Create workspace**: Allow any org member (not just admin). Set `ownerId` to the authenticated user's ID automatically.
- **List workspaces**: Org admins see all; regular members see only their own (`ownerId === userId`).
- **Update/Delete workspace**: Owner or org admin only.
- Remove workspace membership endpoint (`GET .../membership`).

#### `apps/backend/src/routes/member.ts`

- Remove workspace member management endpoints:
  - `POST /members/:memberId/workspaces`
  - `PATCH /members/:memberId/workspaces/:workspaceId`
  - `DELETE /members/:memberId/workspaces/:workspaceId`
- Remove workspace membership data from member list/detail responses.
- **Handle member removal**: When an org member is removed, decide what happens to their workspaces (delete them or orphan them). Recommend: delete the workspaces (cascade).

#### `apps/backend/src/routes/invitation.ts`

- Remove `workspaceId` and `role` from invitation creation.
- Invitation now just invites to the org as a "member".
- Update unique constraint check (per org/email, not workspace/email).
- Remove workspace name from invitation list response.

#### `apps/backend/src/routes/user-invitation.ts`

- **Accept flow**: Create org membership only (no workspace membership step).
- Remove workspace membership creation from the accept transaction.

#### `apps/backend/src/server.ts`

- Remove workspace member routes if they're separately mounted.

### 5. Frontend

#### `apps/frontend/components/auth-provider.tsx`

- Remove workspace membership fetch (`/workspaces/:id/membership`).
- Remove `workspaceMembership`, `workspaceRole`, `canEdit`, `canManage` from context.
- Replace with simpler ownership check: `isWorkspaceOwner` (derived from workspace `ownerId` vs current user).
- Org admin check (`isOrgAdmin`) remains for admin override access.

#### `apps/frontend/components/protected-route.tsx`

- Remove workspace role hierarchy logic.
- Simplify workspace access check to: is owner, is org admin, or is super admin.

#### `apps/frontend/components/workspace-access-dialog.tsx`

- **Delete this component** (no longer needed).

#### `apps/frontend/components/members-list.tsx`

- Remove "Manage Workspace Access" action from member list.
- Remove workspace assignments display from member rows.

#### `apps/frontend/components/member-edit-dialog.tsx`

- Keep as-is (org role editing still needed).

#### `apps/frontend/components/invitation-form.tsx`

- Remove workspace selector and role selector.
- Simplify to just an email input for inviting to the org.

#### Frontend workspace creation

- Allow non-admin org members to access the create workspace UI.
- Update any guards that restrict workspace creation to admins.

### 6. Initialization (`apps/backend/index.ts`)

- When creating the default workspace on first startup, set `ownerId` to the default admin user's ID.

### 7. Data Migration Consideration

- Existing `workspaceMember` records need to be handled. For workspaces with a single member, that member becomes the owner. For workspaces with multiple members, the admin (or first member) becomes the owner.
- Since this project uses `drizzle-kit push` (not migration files), this is a manual/one-time data fixup concern for any deployed instances.

### 8. Tests

- Update existing tests that reference workspace members/roles.
- Add tests for new ownership-based access logic.
- Test that org members can create workspaces.
- Test that org admins can access any workspace.
- Test that non-owner non-admin users are denied access.

---

## Files to Modify (Summary)

| File                                                   | Action                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `apps/backend/src/db/schema.ts`                        | Add ownerId to workspace, drop workspaceMember, simplify invitation  |
| `packages/schemas/index.ts`                            | Remove workspace member schemas, update invitation/workspace schemas |
| `apps/backend/src/middleware/authorization.ts`         | Rewrite requireWorkspaceAccess for ownership model                   |
| `apps/backend/src/routes/workspace.ts`                 | Ownership-based access, allow member creation                        |
| `apps/backend/src/routes/member.ts`                    | Remove workspace member endpoints                                    |
| `apps/backend/src/routes/invitation.ts`                | Remove workspace from invitations                                    |
| `apps/backend/src/routes/user-invitation.ts`           | Simplify accept flow                                                 |
| `apps/backend/index.ts`                                | Set ownerId on default workspace                                     |
| `apps/frontend/components/auth-provider.tsx`           | Remove workspace membership, add ownership                           |
| `apps/frontend/components/protected-route.tsx`         | Simplify workspace access                                            |
| `apps/frontend/components/workspace-access-dialog.tsx` | Delete                                                               |
| `apps/frontend/components/members-list.tsx`            | Remove workspace access management                                   |
| `apps/frontend/components/invitation-form.tsx`         | Remove workspace/role selectors                                      |
| Various frontend pages/layouts                         | Update access checks                                                 |
| Bruno API collection files                             | Update to reflect API changes                                        |

## Out of Scope

- Workspace sharing/collaboration features (future consideration)
- Workspace transfer between users
- Workspace templates
