import { nanoid } from "nanoid";
import { attachment as attachmentTable } from "../db/schema.ts";
import { db } from "../index.ts";
import { NotFoundError } from "../errors.ts";
import {
  tableOf,
  labelOf,
  nounOf,
  workspaceScopedWhere,
  type RowOf,
  type ScopedResourceType,
} from "./scoped-resource.ts";

/**
 * Promote (CONTEXT.md): the Org-Admin action that re-scopes a Workspace-private
 * Scoped resource to Organization scope, turning it into a **Shared resource**
 * and auto-attaching its origin Workspace so it stays visible and usable there
 * (ADR-0007). Editing thereafter happens on the Organization surface.
 *
 * One module owns the mechanism for any {@link ScopedResourceType}; the routes
 * are thin adapters that authorize, run their per-resource precondition, and
 * shape the response. The mechanism was previously copy-pasted inline in the
 * Agent and Skill route handlers, identical apart from the table, the noun, and
 * the Agent's inline no-cascade blocker check, with copies #3 and #4 pending
 * for MCP/Provider.
 *
 * The invariants that make Promote correct live here, once:
 * - only a Workspace-scoped resource in the given Workspace can be promoted;
 * - a lost TOCTOU race (the resource was re-scoped or deleted between the
 *   pre-check lookup and the in-transaction re-scope) becomes `NotFoundError`
 *   (→404) and rolls back the auto-attach so a dangling Attachment is never
 *   left behind;
 * - a unique-constraint violation (a duplicate Shared-resource name) surfaces
 *   from the transaction untouched, to be mapped to 409 by the central
 *   `app.onError` (ADR-0010).
 *
 * The Agent's no-cascade reference guard (`findNonSharedReferences`) is passed
 * in as `guard`, not inlined, so a leaf resource like a Skill and future
 * MCP/Provider surfaces adopt the same mechanism without copying the guard.
 */
export type Database = typeof db;

/**
 * A reference that blocks Promotion because it is not itself Organization-scoped
 * (ADR-0007 no-cascade rule). `name` is so the UI can render a fix-this
 * checklist. The guard decides the concrete shape; this module just carries it.
 */
export type PromoteBlocker = { type: string; id: string; name: string };

/**
 * A route-supplied rule that runs on the pre-check row before the transaction.
 * An Agent passes the no-cascade reference check; a Skill — which references
 * nothing — passes no guard.
 */
export type PromoteGuard<T extends ScopedResourceType> = (
  resource: RowOf[T],
) => Promise<PromoteBlocker[]>;

/** How a guard-backed promote attempt answers — promoted, or blocked pending fixes. */
export type PromoteOutcome<T extends ScopedResourceType> =
  | { ok: true; row: RowOf[T] }
  | { ok: false; message: string; blockers: PromoteBlocker[] };

export type PromoteArgs<T extends ScopedResourceType> = {
  type: T;
  id: string;
  orgId: string;
  workspaceId: string;
};

/** A guarded surface may be blocked; an unguarded leaf cannot, so it narrows. */
export async function promoteScoped<T extends ScopedResourceType>(
  database: Database,
  args: PromoteArgs<T> & { guard: PromoteGuard<T> },
): Promise<PromoteOutcome<T>>;
export async function promoteScoped<T extends ScopedResourceType>(
  database: Database,
  args: PromoteArgs<T> & { guard?: undefined },
): Promise<{ ok: true; row: RowOf[T] }>;
export async function promoteScoped<T extends ScopedResourceType>(
  database: Database,
  args: PromoteArgs<T> & { guard?: PromoteGuard<T> },
): Promise<PromoteOutcome<T>> {
  const { type, id, orgId, workspaceId, guard } = args;
  const table = tableOf(type);

  // Only a Workspace-scoped resource in this Workspace can be promoted.
  const [existing] = await database
    .select()
    .from(table)
    .where(workspaceScopedWhere(type, id, workspaceId))
    .limit(1);
  if (!existing) {
    throw new NotFoundError(`${labelOf(type)} not found`);
  }

  // A route-supplied guard rejects Promotion with a fix-this checklist when a
  // travels-with reference is not itself Organization-scoped (ADR-0007).
  if (guard) {
    const blockers = await guard(existing as RowOf[T]);
    if (blockers.length > 0) {
      return {
        ok: false,
        message: `Promote blocked: this ${nounOf(type)} references workspace-private resources. Promote them first.`,
        blockers,
      };
    }
  }

  // Re-scope and auto-attach atomically. Throwing `NotFoundError` for a lost
  // race rolls back the whole transaction, so we never leave a dangling
  // Attachment; the typed error reaches the central `app.onError` (ADR-0010).
  return database.transaction(async (tx) => {
    const [record] = await tx
      .update(table)
      .set({
        organizationId: orgId,
        workspaceId: null,
        updatedAt: new Date(),
      })
      .where(workspaceScopedWhere(type, id, workspaceId))
      .returning();

    if (!record) {
      throw new NotFoundError(`${labelOf(type)} not found`);
    }

    // Auto-attach the origin Workspace so it keeps seeing the resource.
    await tx
      .insert(attachmentTable)
      .values({
        id: nanoid(),
        workspaceId,
        resourceType: type,
        resourceId: id,
      })
      .onConflictDoNothing();

    return { ok: true as const, row: record as RowOf[T] };
  });
}