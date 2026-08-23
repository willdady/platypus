import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  attachment as attachmentTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import {
  ConflictError,
  isUniqueViolation,
  NotFoundError,
  ValidationError,
} from "../errors.ts";
import { isScopedResourceType, resolveOrgScoped } from "./scoped-resource.ts";

/**
 * The Attachment module: the rules for attaching and detaching a Shared
 * resource to a Workspace (ADR-0007), owned once and adapted over by both HTTP
 * surfaces — `routes/attachment.ts` (per-Workspace) and
 * `routes/org-attachment.ts` (Organization surface). They used to each carry
 * their own copy of the attach/detach insert and diverged on every axis (#605):
 * schema validation vs manual field checks, typed `NotFoundError` vs inline 404
 * JSON, an unguarded path-param cast vs a guard.
 *
 * Three rules live here, in the shapes ADR-0007 states:
 * - **resource-is-Shared**: you can only attach a Shared resource of this
 *   Organization, never a Workspace-private one — `resolveOrgScoped` enforces
 *   it, and a miss is a `NotFoundError` (→404).
 * - **workspace-in-org**: `requireWorkspaceInOrg` — a workspace outside the
 *   Organization is as absent as a missing one (→404). The per-Workspace
 *   surface never calls it directly: `requireWorkspaceAccess` already answers
 *   the same question for a workspace the URL named, so only the Organization
 *   surface (which takes an arbitrary `workspaceId` from the body) needs it.
 * - **already-attached**: the `(workspaceId, resourceType, resourceId)` unique
 *   constraint is the authority; a violation surfaces as a `ConflictError`
 *   (→409) instead of leaking the driver error.
 */

export type AttachmentRow = typeof attachmentTable.$inferSelect;

/**
 * Throws `NotFoundError` when `workspaceId` is not a Workspace of `orgId` —
 * the workspace-in-org rule. Exported so the Organization surface can name it
 * for both its attach and detach routes without duplicating the query.
 */
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

/**
 * Attaches a Shared resource to a Workspace. The resource must be a Shared
 * resource of this Organization (ADR-0007) — a miss is a `NotFoundError`; an
 * insert colliding on the `(workspaceId, resourceType, resourceId)` unique
 * constraint is a `ConflictError` (→409). `resourceType` is untrusted input
 * from the body, so it is validated rather than cast.
 */
export async function attachResource(
  orgId: string,
  resourceType: string | undefined,
  resourceId: string,
  workspaceId: string,
): Promise<AttachmentRow> {
  if (!isScopedResourceType(resourceType)) {
    throw new ValidationError("Invalid resourceType");
  }

  // The resource must be org-scoped and belong to this organization — you can
  // only attach a Shared resource, never a workspace-scoped one.
  const resource = await resolveOrgScoped(db, resourceType, resourceId, orgId);
  if (!resource) {
    throw new NotFoundError(
      "Org-scoped resource not found in this organization",
    );
  }

  try {
    const [row] = await db
      .insert(attachmentTable)
      .values({ id: nanoid(), workspaceId, resourceType, resourceId })
      .returning();
    return row;
  } catch (error) {
    // Already attached → the unique constraint refuses the duplicate pair.
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "This resource is already attached to this workspace",
      );
    }
    throw error;
  }
}

/**
 * Detaches a Shared resource from a Workspace. Throws `NotFoundError` when no
 * such Attachment exists. `resourceType` is untrusted input from the path, so
 * it's validated rather than cast.
 */
export async function detachResource(
  resourceType: string | undefined,
  resourceId: string,
  workspaceId: string,
): Promise<void> {
  if (!isScopedResourceType(resourceType)) {
    throw new ValidationError("Invalid resourceType");
  }

  const result = await db
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
}
