import { Hono } from "hono";
import { validate } from "../validate.ts";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  workspace as workspaceTable,
  organizationMember,
  attachment as attachmentTable,
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
  orgMembershipOf,
  userOf,
} from "../middleware/authorization.ts";
import { listOrgScopedIds } from "../services/scoped-resource.ts";
import { createProvider } from "../services/provider-write.ts";
import { createSandbox } from "../services/sandbox-write.ts";
import { sandboxCreateError } from "../sandbox/validate.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import type { Variables } from "../server.ts";
import {
  deleteWorkspaceRows,
  prepareWorkspaceCleanup,
} from "../services/workspace-delete.ts";
import { transferWorkspace } from "../services/workspace-transfer.ts";
import { requireMemoryProviderCapable } from "../services/memory-provider-validation.ts";
import { oneRow } from "../db/one-row.ts";

const workspace = new Hono<{ Variables: Variables }>();

workspace.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", workspaceCreateSchema),
  async (c) => {
    const user = userOf(c);
    const { orgId } = orgScopeOf(c);
    const data = c.req.valid("json");

    const ownerId = data.ownerId ?? user.id;

    const {
      provider,
      sharedProviderIds = [],
      sandbox,
      ...workspaceFields
    } = data;

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

    const record = await db.transaction(async (tx) => {
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

      const row = oneRow(
        await tx
          .insert(workspaceTable)
          .values({
            id: nanoid(),
            ...workspaceFields,
            organizationId: orgId,
            ownerId,
          })
          .returning(),
      );
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
        await createSandbox(row.id, sandbox, tx);
      }
      return row;
    });
    return c.json(record, 201);
  },
);

workspace.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const orgMembership = orgMembershipOf(c);
  const user = userOf(c);

  if (orgMembership.role === "admin") {
    const results = await db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.organizationId, orgId));
    return c.json({ results });
  }

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

workspace.put(
  "/:workspaceId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate("json", workspaceUpdateSchema),
  async (c) => {
    const scope = workspaceScopeOf(c);
    const { workspaceId } = scope;
    const data = c.req.valid("json");

    const isAdmin = c.get("orgMembership")?.role === "admin";
    if (!isAdmin) {
      delete data.providerSelfManagement;
      delete data.mcpSelfManagement;
      delete data.inboundTriggersAllowed;
    }

    await requireMemoryProviderCapable(data, scope);

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

workspace.post(
  "/:workspaceId/transfer",
  requireAuth,
  requireOrgAccess(["admin"]),
  requireWorkspaceAccess,
  validate("json", workspaceTransferSchema),
  async (c) => {
    const { orgId, workspaceId } = workspaceScopeOf(c);
    await transferWorkspace({
      orgId,
      workspaceId,
      ...c.req.valid("json"),
      transferredBy: userOf(c).name,
    });
    const [record] = await db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, workspaceId));
    return c.json(record);
  },
);

export { workspace };
