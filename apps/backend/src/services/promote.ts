import { nanoid } from "nanoid";
import { attachment as attachmentTable } from "../db/schema.ts";
import type { db } from "../index.ts";
import { NotFoundError } from "../errors.ts";
import {
  tableOf,
  labelOf,
  nounOf,
  workspaceScopedWhere,
  type RowOf,
  type ScopedResourceType,
} from "./scoped-resource.ts";

export type Database = typeof db;

type PromoteBlocker = { type: string; id: string; name: string };

export type PromoteGuard<T extends ScopedResourceType> = (
  resource: RowOf[T],
) => Promise<PromoteBlocker[]>;

export type PromoteOutcome<T extends ScopedResourceType> =
  | { ok: true; row: RowOf[T] }
  | { ok: false; message: string; blockers: PromoteBlocker[] };

export type PromoteArgs<T extends ScopedResourceType> = {
  type: T;
  id: string;
  orgId: string;
  workspaceId: string;
};

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

  const [existing] = await database
    .select()
    .from(table)
    .where(workspaceScopedWhere(type, id, workspaceId))
    .limit(1);
  if (!existing) {
    throw new NotFoundError(`${labelOf(type)} not found`);
  }

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
