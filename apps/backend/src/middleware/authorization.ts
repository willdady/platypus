import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { eq, and } from "drizzle-orm";
import { db } from "../index.ts";
import {
  organizationMember,
  workspace as workspaceTable,
} from "../db/schema.ts";
import type {
  SuperAdminOrgMembership,
  OrgRole,
  OrganizationMembership,
  Variables,
} from "../server.ts";
import {
  orgScope,
  userScope,
  workspaceScope,
  type OrgScope,
  type WorkspaceScope,
} from "../scope.ts";

type Env = { Variables: Variables };

export type Database = typeof db;

type AuthUser = { id: string; role?: string | null };

export const orgScopeOf = (c: Context<Env>): OrgScope => {
  const scope = c.get("orgScope");
  if (!scope) {
    throw new Error(
      "No organization scope on this request: requireOrgAccess must run before the handler",
    );
  }
  return scope;
};

export const workspaceScopeOf = (c: Context<Env>): WorkspaceScope => {
  const scope = c.get("workspaceScope");
  if (!scope) {
    throw new Error(
      "No workspace scope on this request: requireWorkspaceAccess must run before the handler",
    );
  }
  return scope;
};

export const userOf = (c: Context<Env>): NonNullable<Variables["user"]> => {
  const user = c.get("user");
  if (!user) {
    throw new Error(
      "No authenticated user on this request: requireAuth must run before the handler",
    );
  }
  return user;
};

export const orgMembershipOf = (
  c: Context<Env>,
): NonNullable<Variables["orgMembership"]> => {
  const membership = c.get("orgMembership");
  if (!membership) {
    throw new Error(
      "No organization membership on this request: requireOrgAccess must run before the handler",
    );
  }
  return membership;
};

const isSuperAdmin = (user: AuthUser | undefined): boolean => {
  return user?.role === "admin";
};

export const requireOrgAccess = (requiredRoles?: OrgRole[]) =>
  createMiddleware<Env>(async (c, next) => {
    const user = userOf(c);
    const parentScope = userScope(user);
    const orgId = c.req.param("orgId");

    const access = await resolveOrgMembership(db, user, orgId, requiredRoles);

    if (!access.allowed) {
      const { status, message } = ORG_ACCESS_DENIED[access.reason];
      return c.json({ error: message }, status);
    }

    c.set("orgMembership", access.membership);
    // why: a super admin passes with no orgId in the path; there's then no Organization to scope
    if (orgId) {
      c.set("orgScope", orgScope(parentScope, orgId));
    }
    await next();
    return;
  });

type OrgAccessDenial = "org-id-required" | "not-a-member" | "insufficient-role";

export type OrgAccess =
  | {
      allowed: true;
      membership: OrganizationMembership | SuperAdminOrgMembership;
    }
  | { allowed: false; reason: OrgAccessDenial };

const ORG_ACCESS_DENIED: Record<
  OrgAccessDenial,
  { status: 400 | 403; message: string }
> = {
  "org-id-required": { status: 400, message: "Organization ID required" },
  "not-a-member": {
    status: 403,
    message: "Not a member of this organization",
  },
  "insufficient-role": {
    status: 403,
    message: "Insufficient organization permissions",
  },
};

export const resolveOrgMembership = async (
  db: Database,
  user: AuthUser,
  orgId: string | undefined,
  requiredRoles?: OrgRole[],
): Promise<OrgAccess> => {
  if (isSuperAdmin(user)) {
    return {
      allowed: true,
      membership: { role: "admin", isSuperAdmin: true },
    };
  }

  if (!orgId) {
    return { allowed: false, reason: "org-id-required" };
  }

  const [membership] = await db
    .select()
    .from(organizationMember)
    .where(
      and(
        eq(organizationMember.userId, user.id),
        eq(organizationMember.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!membership) {
    return { allowed: false, reason: "not-a-member" };
  }

  if (requiredRoles && !requiredRoles.includes(membership.role)) {
    return { allowed: false, reason: "insufficient-role" };
  }

  return { allowed: true, membership };
};

export const requireWorkspaceAccess = createMiddleware<Env>(async (c, next) => {
  const user = userOf(c);
  const orgMembership = orgMembershipOf(c);

  const parent = orgScopeOf(c);
  const workspaceId = c.req.param("workspaceId");

  if (!workspaceId) {
    return c.json({ error: "Workspace ID required" }, 400);
  }

  const access = await resolveWorkspaceAccess(
    db,
    user,
    orgMembership,
    parent.orgId,
    workspaceId,
  );

  if (!access.allowed) {
    const { status, message } = WORKSPACE_ACCESS_DENIED[access.reason];
    return c.json({ error: message }, status);
  }

  c.set(
    "workspaceScope",
    workspaceScope(parent, workspaceId, access.isWorkspaceOwner),
  );
  await next();
  return;
});

type WorkspaceAccessDenial = "not-found" | "cross-org" | "no-access";

export type WorkspaceAccess =
  | { allowed: true; isWorkspaceOwner: boolean }
  | { allowed: false; reason: WorkspaceAccessDenial };

const WORKSPACE_ACCESS_DENIED: Record<
  WorkspaceAccessDenial,
  { status: 403 | 404; message: string }
> = {
  "not-found": { status: 404, message: "Workspace not found" },
  "cross-org": { status: 404, message: "Workspace not found" },
  "no-access": { status: 403, message: "No access to this workspace" },
};

export const resolveWorkspaceAccess = async (
  db: Database,
  user: AuthUser,
  membership: OrganizationMembership | SuperAdminOrgMembership,
  // why: the org the caller was cleared for, never the row's own, or the cross-org guard is void
  orgId: string,
  workspaceId: string,
): Promise<WorkspaceAccess> => {
  const [ws] = await db
    .select()
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);

  if (!ws) {
    return { allowed: false, reason: "not-found" };
  }

  if (ws.organizationId !== orgId) {
    return { allowed: false, reason: "cross-org" };
  }

  const isOwner = ws.ownerId === user.id;

  const mayAccess =
    isSuperAdmin(user) || membership.role === "admin" || isOwner;
  if (!mayAccess) {
    return { allowed: false, reason: "no-access" };
  }

  return { allowed: true, isWorkspaceOwner: isOwner };
};

// why: absent and refused are one false (callers answer 404), or a stranger learns it exists
export const userMayUseWorkspace = async (
  db: Database,
  user: AuthUser,
  workspaceId: string,
): Promise<boolean> => {
  const [ws] = await db
    .select({ organizationId: workspaceTable.organizationId })
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);
  if (!ws) return false;

  const org = await resolveOrgMembership(db, user, ws.organizationId);
  if (!org.allowed) return false;

  const access = await resolveWorkspaceAccess(
    db,
    user,
    org.membership,
    ws.organizationId,
    workspaceId,
  );
  return access.allowed;
};

export const requireWorkspaceConfigAccess = (
  delegationFlag: DelegationFlag | null,
) =>
  createMiddleware<Env>(async (c, next) => {
    const access = await workspaceConfigAccess(c, delegationFlag);

    if (!access.allowed) {
      return c.json({ error: CONFIG_ACCESS_DENIED[access.reason] }, 403);
    }

    await next();
    return;
  });

export type DelegationFlag = "providerSelfManagement" | "mcpSelfManagement";

type ConfigAccessDenial = "not-owner" | "not-delegatable" | "not-delegated";

export type WorkspaceConfigAccess =
  { allowed: true } | { allowed: false; reason: ConfigAccessDenial };

const CONFIG_ACCESS_DENIED: Record<ConfigAccessDenial, string> = {
  "not-owner": "Admin access required",
  "not-delegatable": "Only an organization admin can configure this resource",
  "not-delegated":
    "Self-management of this resource is not enabled for this workspace",
};

const workspaceConfigAccess = async (
  c: Context<Env>,
  delegationFlag: DelegationFlag | null,
): Promise<WorkspaceConfigAccess> => {
  const user = c.get("user");
  const orgMembership = c.get("orgMembership");

  if (isSuperAdmin(user) || orgMembership?.role === "admin") {
    return { allowed: true };
  }

  if (!workspaceScopeOf(c).isWorkspaceOwner) {
    return { allowed: false, reason: "not-owner" };
  }

  if (!delegationFlag) {
    return { allowed: false, reason: "not-delegatable" };
  }

  const { workspaceId } = workspaceScopeOf(c);
  const [ws] = await db
    .select({ flag: workspaceTable[delegationFlag] })
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);

  if (!ws?.flag) {
    return { allowed: false, reason: "not-delegated" };
  }

  return { allowed: true };
};

export type CredentialResourceType = "mcp" | "provider";

const CREDENTIAL_DELEGATION_FLAG: Record<
  CredentialResourceType,
  DelegationFlag
> = {
  mcp: "mcpSelfManagement",
  provider: "providerSelfManagement",
};

export const workspaceCredentialsVisible = async (
  c: Context<Env>,
  type: CredentialResourceType,
): Promise<boolean> =>
  (await workspaceConfigAccess(c, CREDENTIAL_DELEGATION_FLAG[type])).allowed;

export const orgCredentialsVisible = (c: Context<Env>): boolean =>
  c.get("orgMembership")?.role === "admin";

export const requireSuperAdmin = createMiddleware<Env>(async (c, next) => {
  const user = c.get("user");

  if (!isSuperAdmin(user)) {
    return c.json({ error: "Super admin access required" }, 403);
  }

  await next();
  return;
});

export const requireWorkspaceOwner = createMiddleware<Env>(async (c, next) => {
  if (!workspaceScopeOf(c).isWorkspaceOwner) {
    return c.json(
      { error: "Only the workspace owner can perform this action" },
      403,
    );
  }

  await next();
  return;
});

export { isSuperAdmin };
