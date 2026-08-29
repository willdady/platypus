import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  workspace as workspaceTable,
  organizationMember,
  provider as providerTable,
} from "../db/schema.ts";
import {
  workspaceCreateSchema,
  workspaceUpdateSchema,
} from "@platypus/schemas";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  orgScopeOf,
  requireOrgAccess,
  requireWorkspaceAccess,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import { resolveScoped } from "../services/scoped-resource.ts";
import type { Variables } from "../server.ts";
import { destroyWorkspaceSandboxes } from "../sandbox/teardown.ts";

const workspace = new Hono<{ Variables: Variables }>();

/** Create a new workspace (org admin only, ADR-0008) */
workspace.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", workspaceCreateSchema),
  async (c) => {
    const user = c.get("user")!;
    const { orgId } = orgScopeOf(c);
    const data = c.req.valid("json");

    // ownerId is admin-assignable (ADR-0008); default to the calling admin
    // when not supplied. A named owner must be a member of the organization —
    // governance would be meaningless if an admin could hand a workspace to a
    // non-member (or a typo'd / cross-org user id).
    const ownerId = data.ownerId ?? user.id;
    if (data.ownerId && data.ownerId !== user.id) {
      const [member] = await db
        .select({ userId: organizationMember.userId })
        .from(organizationMember)
        .where(
          and(
            eq(organizationMember.organizationId, orgId),
            eq(organizationMember.userId, data.ownerId),
          ),
        )
        .limit(1);

      if (!member) {
        return c.json(
          { error: "Owner must be a member of the organization" },
          400,
        );
      }
    }

    const record = await db
      .insert(workspaceTable)
      .values({
        id: nanoid(),
        ...data,
        // The route's organization has already passed requireOrgAccess. Never
        // take this tenancy boundary from client input: an admin of one org
        // must not be able to create a workspace in another org.
        organizationId: orgId,
        ownerId,
      })
      .returning();
    return c.json(record[0], 201);
  },
);

/** List all workspaces */
workspace.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const orgMembership = c.get("orgMembership")!;
  const user = c.get("user")!;

  // If admin, return all workspaces
  if (orgMembership.role === "admin") {
    const results = await db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.organizationId, orgId));
    return c.json({ results });
  }

  // If regular member, return only workspaces they own
  const results = await db
    .select()
    .from(workspaceTable)
    .where(
      and(
        eq(workspaceTable.organizationId, orgId),
        eq(workspaceTable.ownerId, user.id),
      ),
    );
  return c.json({ results });
});

/** Get a workspace by ID */
workspace.get(
  "/:workspaceId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const record = await db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, workspaceId))
      .limit(1);
    if (record.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    return c.json(record[0]);
  },
);

/** Update a workspace by ID (owner or org admin) */
workspace.put(
  "/:workspaceId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", workspaceUpdateSchema),
  async (c) => {
    const scope = workspaceScopeOf(c);
    const { workspaceId } = scope;
    const data = c.req.valid("json");

    // Delegation flags (ADR-0006) are admin-only. A non-admin owner may edit
    // their workspace's other settings, but must not grant themselves
    // self-management of credential-bearing resources, so strip these fields
    // unless the caller is an org admin (super admins carry role "admin" too).
    const isAdmin = c.get("orgMembership")?.role === "admin";
    if (!isAdmin) {
      delete data.providerSelfManagement;
      delete data.mcpSelfManagement;
    }

    // Resolve memory pointer-settings through the Scoped resource authority
    // (ADR-0007): a Provider is settable only if it is visible in this
    // Workspace — its own, or an Organization-scoped one Attached to it. A bare
    // id lookup would let an owner stamp any Organization's Provider onto their
    // Workspace, which the memory-extraction job and memorySearch then use with
    // that Provider's credentials.
    if (data.memoryExtractionProviderId) {
      const resolved = await resolveScoped(
        db,
        "provider",
        data.memoryExtractionProviderId,
        scope,
      );

      if (!resolved) {
        return c.json({ error: "Memory extraction provider not found" }, 404);
      }

      if (!resolved.row.memoryExtractionModelId) {
        return c.json(
          {
            error:
              "Selected provider does not have a memory extraction model configured",
          },
          400,
        );
      }
    }

    if (data.memoryEmbeddingProviderId) {
      const resolved = await resolveScoped(
        db,
        "provider",
        data.memoryEmbeddingProviderId,
        scope,
      );

      if (!resolved) {
        return c.json({ error: "Memory embedding provider not found" }, 404);
      }

      if (!resolved.row.embeddingModelId) {
        return c.json(
          {
            error:
              "Selected provider does not have an embedding model configured",
          },
          400,
        );
      }
    }

    const record = await db
      .update(workspaceTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(workspaceTable.id, workspaceId))
      .returning();

    if (record.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    return c.json(record[0], 200);
  },
);

/** Delete a workspace by ID (owner or org admin) */
workspace.delete(
  "/:workspaceId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    // Best-effort sandbox teardown before the DB cascade fires. Never throws;
    // failures are recorded in sandbox_teardown_failure (ADR-0001).
    await destroyWorkspaceSandboxes(workspaceId);
    // `provider` carries no FK to `workspace` (issue #661) — a cascade FK
    // would race `agent.providerId`'s `restrict` constraint, since Postgres
    // checks RESTRICT immediately rather than deferring to end of statement.
    // Delete the workspace first (cascading its Agents away) so the
    // Workspace-scoped Providers below are no longer referenced, then delete
    // them explicitly, all within one transaction.
    await db.transaction(async (tx) => {
      await tx.delete(workspaceTable).where(eq(workspaceTable.id, workspaceId));
      await tx
        .delete(providerTable)
        .where(eq(providerTable.workspaceId, workspaceId));
    });
    return c.json({ message: "Workspace deleted" });
  },
);

export { workspace };
