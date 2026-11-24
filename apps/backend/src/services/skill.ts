import type { z } from "zod";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  skill as skillTable,
  skillFile as skillFileTable,
  agent as agentTable,
} from "../db/schema.ts";
import type { skillCreateSchema, skillUpdateSchema } from "@platypus/schemas";
import type { ScopeContext } from "../scope.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { skillStorageKeyPrefix } from "../storage/keys.ts";
import { deleteStoredPrefix } from "../storage/utils.ts";
import { scrubDeletedAgentReference } from "./agent-references.ts";
import {
  orgScopedWhere,
  requireSharedDeletable,
  requireWorkspaceMutable,
  resolveScopedByName,
  workspaceScopedWhere,
} from "./scoped-resource.ts";
import { bundleHash } from "./skill-bundle-format.ts";
import {
  copySkillFilesTo,
  fieldsOf,
  listSkillFiles,
  rehashSkill,
  scopeColumnsOf,
  writableSkillWhere,
} from "./skill-bundle.ts";
import { oneRow } from "../db/one-row.ts";

export type SkillRow = typeof skillTable.$inferSelect;

export type SkillCreateFields = z.input<typeof skillCreateSchema>;

export type SkillUpdateFields = z.infer<typeof skillUpdateSchema>;

export type SkillScope =
  | { kind: "workspace"; ctx: ScopeContext }
  | { kind: "organization"; orgId: string };

const assignToAgents = async (
  workspaceId: string,
  skillId: string,
  agentIds: string[],
): Promise<void> => {
  if (agentIds.length === 0) return;
  const skillIdJson = JSON.stringify([skillId]);
  await db
    .update(agentTable)
    .set({
      skillIds: sql`${agentTable.skillIds} || ${skillIdJson}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agentTable.workspaceId, workspaceId),
        inArray(agentTable.id, agentIds),
        sql`NOT ${agentTable.skillIds} @> ${skillIdJson}::jsonb`,
      ),
    );
};

const syncAgentAssignments = async (
  workspaceId: string,
  skillId: string,
  agentIds: string[],
): Promise<void> => {
  const now = new Date();
  const skillIdJson = JSON.stringify([skillId]);

  const removeWhere = [
    eq(agentTable.workspaceId, workspaceId),
    sql`${agentTable.skillIds} @> ${skillIdJson}::jsonb`,
  ];
  if (agentIds.length > 0) {
    removeWhere.push(notInArray(agentTable.id, agentIds));
  }
  await db
    .update(agentTable)
    .set({
      skillIds: sql`(${agentTable.skillIds})::jsonb - ${skillId}::text`,
      updatedAt: now,
    })
    .where(and(...removeWhere));

  await assignToAgents(workspaceId, skillId, agentIds);
};

export async function createSkill(
  scope: SkillScope,
  fields: SkillCreateFields,
): Promise<SkillRow> {
  const { agentIds, ...data } = fields;

  const row = oneRow(
    await db
      .insert(skillTable)
      .values({
        id: nanoid(),
        ...data,
        bundleHash: bundleHash({
          fields: fieldsOf(data),
          frontmatter: {},
          files: [],
        }),
        ...scopeColumnsOf(scope),
      })
      .returning(),
  );

  if (scope.kind === "workspace" && agentIds) {
    await assignToAgents(scope.ctx.workspaceId, row.id, agentIds);
  }
  return row;
}

export async function updateSkill(
  scope: SkillScope,
  skillId: string,
  fields: SkillUpdateFields,
): Promise<SkillRow> {
  const { agentIds, ...data } = fields;

  const where = await writableSkillWhere(scope, skillId);

  // why: rehash in the update's transaction, or a concurrent Replace bundle slips between
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(skillTable)
      .set({ ...data, updatedAt: new Date() })
      .where(where)
      .returning();
    return updated && rehashSkill(tx, updated);
  });

  if (!row) {
    throw new NotFoundError("Skill not found");
  }

  if (scope.kind === "workspace" && agentIds !== undefined) {
    await syncAgentAssignments(scope.ctx.workspaceId, skillId, agentIds);
  }
  return row;
}

export async function upsertSkill(
  ctx: ScopeContext,
  fields: { name: string; description: string; body: string },
): Promise<SkillRow> {
  const existing = await resolveScopedByName(db, "skill", fields.name, ctx);
  const sharedFiles =
    existing?.scope === "organization"
      ? await listSkillFiles(db, existing.row.id)
      : [];

  const now = new Date();
  const id = nanoid();
  const copied =
    sharedFiles.length > 0
      ? await copySkillFilesTo(ctx.orgId, id, sharedFiles)
      : null;

  try {
    const row = await db.transaction(async (tx) => {
      const upserted = oneRow(
        await tx
          .insert(skillTable)
          .values({
            id,
            workspaceId: ctx.workspaceId,
            name: fields.name,
            description: fields.description,
            body: fields.body,
            ...(copied && { needsSandbox: copied.needsSandbox }),
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [skillTable.workspaceId, skillTable.name],
            set: {
              description: fields.description,
              body: fields.body,
              updatedAt: now,
            },
          })
          .returning(),
      );
      if (copied && upserted.id === id) {
        await tx.insert(skillFileTable).values(copied.rows);
      }
      return rehashSkill(tx, upserted);
    });
    // why: a racing Workspace row won the name, so the copies belong to nobody
    if (copied && row.id !== id) await deleteStoredPrefix(copied.prefix);
    return row;
  } catch (error) {
    if (copied) await deleteStoredPrefix(copied.prefix);
    throw error;
  }
}

export async function deleteSkill(
  scope: SkillScope,
  skillId: string,
): Promise<void> {
  if (scope.kind === "workspace") {
    await requireWorkspaceMutable(db, "skill", skillId, scope.ctx);

    // why: not inUseConflict; its delete-or-switch remedy is wrong for an agent's Skill list
    const referencingAgents = await db
      .select({ id: agentTable.id, name: agentTable.name })
      .from(agentTable)
      .where(
        and(
          eq(agentTable.workspaceId, scope.ctx.workspaceId),
          sql`${agentTable.skillIds} @> ${JSON.stringify([skillId])}::jsonb`,
        ),
      )
      .orderBy(agentTable.name);
    if (referencingAgents.length > 0) {
      const one = referencingAgents.length === 1;
      const quoted = referencingAgents.map((a) => `"${a.name}"`).join(", ");
      throw new ConflictError(
        `Cannot delete: this skill is enabled for ${referencingAgents.length} agent${
          one ? "" : "s"
        } (${quoted}). Turn it off for ${one ? "that agent" : "those agents"} first.`,
      );
    }

    await db
      .delete(skillTable)
      .where(workspaceScopedWhere("skill", skillId, scope.ctx.workspaceId));
    await deleteStoredPrefix(
      skillStorageKeyPrefix({ orgId: scope.ctx.orgId, skillId }),
    );
    return;
  }

  await requireSharedDeletable(db, "skill", skillId);

  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(skillTable)
      .where(orgScopedWhere("skill", skillId, scope.orgId))
      .returning();
    if (rows.length > 0) {
      await scrubDeletedAgentReference(tx, "skillIds", skillId);
    }
    return rows;
  });
  if (result.length === 0) {
    throw new NotFoundError("Skill not found");
  }
  await deleteStoredPrefix(
    skillStorageKeyPrefix({ orgId: scope.orgId, skillId }),
  );
}
