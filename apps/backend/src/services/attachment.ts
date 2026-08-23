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
 * - **workspace-in-org**: a workspace outside the Organization is as absent as
 *   a missing one (→404). Only the Organization surface needs it, since it
 *   takes an arbitrary `workspaceId` from the request; the per-Workspace
 *   surface has already had `requireWorkspaceAccess` answer the same question.
 *   `AttachmentScope` is how a caller says which of the two it is.
 * - **already-attached**: the `(workspaceId, resourceType, resourceId)` unique
 *   constraint is the authority; a violation surfaces as a `ConflictError`
 *   (→409) instead of leaking the driver error.
 *
 * The *order* those rules run in is part of the contract, not the caller's to
 * remember: a request that trips more than one must fail on the same rule it
 * always did (an invalid `resourceType` is a 400 even when the workspace is
 * also out of org). Keeping the sequence here is what stops the two surfaces
 * drifting on precedence the way they drifted on everything else.
 */

export type AttachmentRow = typeof attachmentTable.$inferSelect;

/**
 * Which surface a write comes from — the per-Workspace route, whose
 * `workspaceId` the middleware already proved belongs to the Organization, or
 * the Organization route, which names an arbitrary workspace and must have it
 * checked. Mirrors `SkillScope`/`ProviderScope`.
 */
export type AttachmentScope = { kind: "workspace" } | { kind: "organization" };

/**
 * The resource an attach or detach names. `resourceType` is untrusted input
 * from a body or a path on both surfaces, so it is validated rather than cast;
 * the Organization attach surface reads the whole triple from an unvalidated
 * body, so every field arrives possibly absent.
 */
export type AttachmentTarget = {
  resourceType: string | undefined;
  resourceId: string | undefined;
  workspaceId: string | undefined;
};

/**
 * Throws `NotFoundError` when `workspaceId` is not a Workspace of `orgId` —
 * the workspace-in-org rule.
 */
const requireWorkspaceInOrg = async (
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
 * Attaches a Shared resource to a Workspace, applying the three rules in the
 * order described above. Returns the new Attachment row.
 */
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
 * Detaches a Shared resource from a Workspace. Both identifying fields reach
 * this from a path, so only `resourceType` needs validating; the rules run in
 * the same order as `attachResource` — bad type before out-of-org workspace.
 * Throws `NotFoundError` when no such Attachment exists.
 */
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
