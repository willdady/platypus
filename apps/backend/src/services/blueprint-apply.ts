import { eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Tx } from "../index.ts";
import {
  blueprint as blueprintTable,
  blueprintItem as blueprintItemTable,
  attachment as attachmentTable,
  workspace as workspaceTable,
} from "../db/schema.ts";

const TIER2_FIELDS = [
  "taskModelProviderId",
  "memoryExtractionProviderId",
  "memoryEmbeddingProviderId",
  "context",
] as const;

export interface ApplyBlueprintsResult {
  attached: number;
  skipped: number;
  total: number;
}

export const applyBlueprintsToWorkspace = async (
  exec: Tx,
  workspaceId: string,
  blueprintIds: string[],
): Promise<ApplyBlueprintsResult> => {
  if (blueprintIds.length === 0) {
    return { attached: 0, skipped: 0, total: 0 };
  }

  const blueprints = await exec
    .select({
      id: blueprintTable.id,
      taskModelProviderId: blueprintTable.taskModelProviderId,
      memoryExtractionProviderId: blueprintTable.memoryExtractionProviderId,
      memoryEmbeddingProviderId: blueprintTable.memoryEmbeddingProviderId,
      context: blueprintTable.context,
    })
    .from(blueprintTable)
    .where(inArray(blueprintTable.id, blueprintIds));
  const byId = new Map(blueprints.map((b) => [b.id, b]));

  const itemRows = await exec
    .select({
      resourceType: blueprintItemTable.resourceType,
      resourceId: blueprintItemTable.resourceId,
    })
    .from(blueprintItemTable)
    .where(inArray(blueprintItemTable.blueprintId, blueprintIds));

  const seen = new Set<string>();
  const attachValues: {
    id: string;
    workspaceId: string;
    resourceType: (typeof itemRows)[number]["resourceType"];
    resourceId: string;
  }[] = [];
  for (const row of itemRows) {
    const key = `${row.resourceType}:${row.resourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    attachValues.push({
      id: nanoid(),
      workspaceId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
    });
  }

  let attached = 0;
  if (attachValues.length > 0) {
    const inserted = await exec
      .insert(attachmentTable)
      .values(attachValues)
      .onConflictDoNothing()
      .returning();
    attached = inserted.length;
  }

  const merged: Record<string, string> = {};
  for (const id of blueprintIds) {
    const bp = byId.get(id);
    if (!bp) continue;
    for (const field of TIER2_FIELDS) {
      const value = bp[field];
      if (value !== null) {
        merged[field] = value;
      }
    }
  }
  if (Object.keys(merged).length > 0) {
    await exec
      .update(workspaceTable)
      .set({ ...merged, updatedAt: new Date() })
      .where(eq(workspaceTable.id, workspaceId));
  }

  return {
    attached,
    skipped: attachValues.length - attached,
    total: attachValues.length,
  };
};
