import { eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  blueprint as blueprintTable,
  blueprintItem as blueprintItemTable,
  attachment as attachmentTable,
  workspace as workspaceTable,
} from "../db/schema.ts";

// Any query executor — the top-level `db` or a transaction handle. Both share
// the query-builder surface this module uses, so callers can wrap a multi-step
// apply in their own transaction (invite-accept does; ad-hoc apply does too).
type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0];

// The Workspace pointer-settings a Blueprint can stamp (ADR-0008, Tier 2).
const TIER2_FIELDS = [
  "taskModelProviderId",
  "memoryExtractionProviderId",
  "memoryEmbeddingProviderId",
  "context",
] as const;

export interface ApplyBlueprintsResult {
  // Attachments actually created (Tier 1 union, minus those already present).
  attached: number;
  // Distinct Attachments that already existed and were skipped.
  skipped: number;
  // Distinct Attachments the Blueprint set spans (the union size).
  total: number;
}

/**
 * Apply an ordered set of Blueprints to a Workspace (ADR-0008, ADR-0009).
 *
 * Tier 1 Attachments compose as an idempotent **union** — duplicates across the
 * set collapse, and `onConflictDoNothing` skips anything already attached, so
 * re-runs only add what is missing. Tier 2 pointer-settings are single-valued,
 * so when several Blueprints set the same slot the **later one in `blueprintIds`
 * wins** (last-write-wins); a Blueprint that leaves a slot null never clobbers
 * an earlier winner or the Workspace's existing value.
 *
 * Runs entirely on the supplied executor so the caller controls the transaction
 * boundary — accept-time provisioning applies the whole set atomically.
 */
export const applyBlueprintsToWorkspace = async (
  exec: Executor,
  workspaceId: string,
  blueprintIds: string[],
): Promise<ApplyBlueprintsResult> => {
  if (blueprintIds.length === 0) {
    return { attached: 0, skipped: 0, total: 0 };
  }

  // Tier 2 source values, keyed by id so we can walk them in `blueprintIds`
  // order (the select returns them unordered).
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

  // Tier 1 — dedupe the union across the set so the insert has no internal
  // conflict; onConflictDoNothing then handles rows already on the Workspace.
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

  // Tier 2 — last-write-wins. Walk the set in order; each Blueprint's non-null
  // slots overwrite earlier ones. Null slots are left out entirely so they
  // never null an earlier winner or the Workspace's current value.
  const merged: Record<string, string> = {};
  for (const id of blueprintIds) {
    const bp = byId.get(id);
    if (!bp) continue;
    for (const field of TIER2_FIELDS) {
      const value = bp[field];
      if (value !== null && value !== undefined) {
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
