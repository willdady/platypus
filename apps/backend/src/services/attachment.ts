import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  a2aEndpoint as a2aEndpointTable,
  attachment as attachmentTable,
  workspace as workspaceTable,
  workspaceAgentPin as workspaceAgentPinTable,
} from "../db/schema.ts";
import {
  ConflictError,
  isUniqueViolation,
  NotFoundError,
  ValidationError,
} from "../errors.ts";
import { isScopedResourceType, resolveOrgScoped } from "./scoped-resource.ts";
import { agentPinWhere } from "./agent-pin.ts";
import { oneRow } from "../db/one-row.ts";

export type AttachmentRow = typeof attachmentTable.$inferSelect;

export type AttachmentScope = { kind: "workspace" } | { kind: "organization" };

export type AttachmentTarget = {
  resourceType: string;
  resourceId: string;
  workspaceId: string;
};

export const requireWorkspaceInOrg = async (
  orgId: string,
  workspaceId: string,
): Promise<void> => {
  const [ws] = await db
    .select({ id: workspaceTable.id })
    .from(workspaceTable)
    .where(
      and(
        eq(workspaceTable.id, workspaceId),
        eq(workspaceTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!ws) {
    throw new NotFoundError("Workspace not found in this organization");
  }
};

export async function attachResource(
  scope: AttachmentScope,
  orgId: string,
  target: AttachmentTarget,
): Promise<AttachmentRow> {
  const { resourceType, resourceId, workspaceId } = target;

  if (!isScopedResourceType(resourceType)) {
    throw new ValidationError("Invalid resourceType");
  }
  if (!resourceId || !workspaceId) {
    throw new ValidationError("resourceId and workspaceId are required");
  }

  if (scope.kind === "organization") {
    await requireWorkspaceInOrg(orgId, workspaceId);
  }

  const resource = await resolveOrgScoped(db, resourceType, resourceId, orgId);
  if (!resource) {
    throw new NotFoundError(
      "Org-scoped resource not found in this organization",
    );
  }

  try {
    const row = oneRow(
      await db
        .insert(attachmentTable)
        .values({ id: nanoid(), workspaceId, resourceType, resourceId })
        .returning(),
    );
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "This resource is already attached to this workspace",
      );
    }
    throw error;
  }
}

export async function detachResource(
  scope: AttachmentScope,
  orgId: string,
  target: AttachmentTarget,
): Promise<void> {
  const { resourceType, resourceId, workspaceId } = target;

  if (!isScopedResourceType(resourceType)) {
    throw new ValidationError("Invalid resourceType");
  }
  if (!resourceId || !workspaceId) {
    throw new ValidationError("resourceId and workspaceId are required");
  }

  if (scope.kind === "organization") {
    await requireWorkspaceInOrg(orgId, workspaceId);
  }

  await db.transaction(async (tx) => {
    const result = await tx
      .delete(attachmentTable)
      .where(
        and(
          eq(attachmentTable.workspaceId, workspaceId),
          eq(attachmentTable.resourceType, resourceType),
          eq(attachmentTable.resourceId, resourceId),
        ),
      )
      .returning();
    if (result.length === 0) {
      throw new NotFoundError("Attachment not found");
    }
    if (resourceType === "agent") {
      await tx
        .delete(a2aEndpointTable)
        .where(
          and(
            eq(a2aEndpointTable.workspaceId, workspaceId),
            eq(a2aEndpointTable.agentId, resourceId),
          ),
        );
      await tx
        .delete(workspaceAgentPinTable)
        .where(agentPinWhere(workspaceId, resourceId));
    }
  });
}
