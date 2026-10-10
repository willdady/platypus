import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  workspace as workspaceTable,
  organizationMember,
  attachment as attachmentTable,
  sandbox as sandboxTable,
} from "../db/schema.ts";
import {
  workspaceCreateSchema,
  workspaceTransferSchema,
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
import {
  listOrgScopedIds,
  resolveScoped,
} from "../services/scoped-resource.ts";
import { createProvider } from "../services/provider-write.ts";
import { sandboxCreateError } from "../sandbox/validate.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import type { Variables } from "../server.ts";
import {
  deleteWorkspaceRows,
  prepareWorkspaceCleanup,
} from "../services/workspace-delete.ts";
import { transferWorkspace } from "../services/workspace-transfer.ts";

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
    // when not supplied.
    const ownerId = data.ownerId ?? user.id;

    const {
      provider,
      sharedProviderIds = [],
      sandbox,
      ...workspaceFields
    } = data;

    // Everything that can fail on its own is checked before anything is
    // written, so the transaction below only fails on the database.
    const found = await listOrgScopedIds(
      db,
      "provider",
      sharedProviderIds,
      orgId,
    );
    if (sharedProviderIds.some((id) => !found.has(id))) {
      throw new NotFoundError(
        "Org-scoped resource not found in this organization",
      );
    }
    if (sandbox) {
      const sandboxError = sandboxCreateError(sandbox);
      if (sandboxError) return c.json({ error: sandboxError }, 400);
    }

    // The Workspace and the resources it is provisioned with land together or
    // not at all — a failed Provider must not leave an unusable Workspace.
    const record = await db.transaction(async (tx) => {
      // The owner must be a member of the organization — governance would be
      // meaningless if an admin could hand a workspace to a non-member (or a
      // typo'd / cross-org user id); a super admin needs none for their own.
      // Held until commit, so removing the owner meanwhile waits and must then
      // decide this Workspace too (ADR-0035).
      const [member] = await tx
        .select({ userId: organizationMember.userId })
        .from(organizationMember)
        .where(
          and(
            eq(organizationMember.organizationId, orgId),
            eq(organizationMember.userId, ownerId),
          ),
        )
        .for("share")
        .limit(1);
      if (!member && !(ownerId === user.id && user.role === "admin")) {
        throw new ValidationError("Owner must be a member of the organization");
      }

      const [row] = await tx
        .insert(workspaceTable)
        .values({
          id: nanoid(),
          ...workspaceFields,
          // The route's organization has already passed requireOrgAccess.
          // Never take this tenancy boundary from client input: an admin of one
          // org must not be able to create a workspace in another org.
          organizationId: orgId,
          ownerId,
        })
        .returning();
      const ctx = { orgId, workspaceId: row.id };

      if (provider) {
        await createProvider({ kind: "workspace", ctx }, provider, tx);
      }
      if (sharedProviderIds.length > 0) {
        await tx.insert(attachmentTable).values(
          [...new Set(sharedProviderIds)].map((resourceId) => ({
            id: nanoid(),
            workspaceId: row.id,
            resourceType: "provider" as const,
            resourceId,
          })),
        );
      }
      if (sandbox) {
        await tx
          .insert(sandboxTable)
          .values({ id: nanoid(), ...sandbox, workspaceId: row.id });
      }
      return row;
    });
    return c.json(record, 201);
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
      // Same rule for the Inbound Trigger allow flag (ADR-0030): the Org
      // Admin decides which Workspaces take calls from outside.
      delete data.inboundTriggersAllowed;
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
    const scope = workspaceScopeOf(c);
    const cleanUp = await prepareWorkspaceCleanup(scope);
    await db.transaction((tx) => deleteWorkspaceRows(tx, scope.workspaceId));
    await cleanUp();
    return c.json({ message: "Workspace deleted" });
  },
);

/** Transfer a workspace to another member (org admin only, ADR-0035) */
workspace.post(
  "/:workspaceId/transfer",
  requireAuth,
  requireOrgAccess(["admin"]),
  requireWorkspaceAccess,
  sValidator("json", workspaceTransferSchema),
  async (c) => {
    const { orgId, workspaceId } = workspaceScopeOf(c);
    await transferWorkspace({
      orgId,
      workspaceId,
      ...c.req.valid("json"),
      transferredBy: c.get("user")!.name,
    });
    const [record] = await db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, workspaceId));
    return c.json(record);
  },
);

export { workspace };
