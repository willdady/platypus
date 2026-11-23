import { nanoid } from "nanoid";
import type { z } from "zod";
import type { agentBaseSchema } from "@platypus/schemas";
import {
  FALLBACK_PAIR_MESSAGE,
  FALLBACK_SAME_MODEL_MESSAGE,
} from "@platypus/schemas";
import { eq, type SQL } from "drizzle-orm";
import { db } from "../index.ts";
import { agent as agentTable, trigger as triggerTable } from "../db/schema.ts";
import type { ScopeContext } from "../scope.ts";
import {
  validateSubAgentAssignment,
  SUB_AGENT_SELF_ASSIGNMENT_ERROR,
} from "./sub-agent-validation.ts";
import {
  findNonSharedReferences,
  type ReferenceBlocker,
} from "./agent-scope-validation.ts";
import { scrubDeletedAgentReference } from "./agent-references.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import {
  inUseConflict,
  orgScopedWhere,
  requireOrgScoped,
  requireSharedDeletable,
  requireWorkspaceMutable,
  resolveOrgScoped,
  resolveScoped,
  workspaceScopedWhere,
} from "./scoped-resource.ts";
import { resolveModelId } from "./model-capability.ts";
import type { ProviderRow } from "./provider-write.ts";
import { deleteAvatar, storeAvatar } from "./avatar.ts";
import { oneRow } from "../db/one-row.ts";

type AgentRow = typeof agentTable.$inferSelect;

export type AgentCreateFields = Omit<
  z.infer<typeof agentBaseSchema>,
  | "id"
  | "organizationId"
  | "workspaceId"
  | "avatarUrl"
  | "createdAt"
  | "updatedAt"
>;

export type AgentUpdateFields = Partial<AgentCreateFields>;

export type AgentWriteError = { error: string; blockers?: ReferenceBlocker[] };

export type AgentWriteResult = { row: AgentRow } | AgentWriteError;

export type AgentScope =
  | { kind: "workspace"; ctx: ScopeContext }
  | { kind: "organization"; orgId: string };

type IdArrayFields = Pick<
  AgentUpdateFields,
  "toolSetIds" | "skillIds" | "subAgentIds"
>;

const dedupeIdArrays = <T extends IdArrayFields>(fields: T): T => ({
  ...fields,
  ...(fields.toolSetIds && { toolSetIds: [...new Set(fields.toolSetIds)] }),
  ...(fields.skillIds && { skillIds: [...new Set(fields.skillIds)] }),
  ...(fields.subAgentIds && {
    subAgentIds: [...new Set(fields.subAgentIds)],
  }),
});

const normaliseReference = (
  value: string | null | undefined,
): string | null | undefined =>
  value === undefined ? undefined : value?.trim() ? value : null;

const normaliseFallbackFields = (
  fields: Pick<AgentUpdateFields, "fallbackProviderId" | "fallbackModelId">,
): Pick<AgentUpdateFields, "fallbackProviderId" | "fallbackModelId"> => ({
  ...(fields.fallbackProviderId !== undefined
    ? { fallbackProviderId: normaliseReference(fields.fallbackProviderId) }
    : {}),
  ...(fields.fallbackModelId !== undefined
    ? { fallbackModelId: normaliseReference(fields.fallbackModelId) }
    : {}),
});

type FallbackPair = {
  providerId: string | null;
  modelId: string | null;
};

const providerInScope = async (
  scope: AgentScope,
  providerId: string,
): Promise<ProviderRow | undefined> => {
  const row =
    scope.kind === "workspace"
      ? (await resolveScoped(db, "provider", providerId, scope.ctx))?.row
      : await resolveOrgScoped(db, "provider", providerId, scope.orgId);
  return row ?? undefined;
};

const validateFallbackPair = async (
  scope: AgentScope,
  primary: { providerId: string; modelId: string },
  fallback: FallbackPair,
): Promise<AgentWriteError | null> => {
  if ((fallback.providerId === null) !== (fallback.modelId === null)) {
    return { error: FALLBACK_PAIR_MESSAGE };
  }
  if (fallback.providerId === null || fallback.modelId === null) return null;

  const provider = await providerInScope(scope, fallback.providerId);
  if (!provider) {
    return {
      error:
        "The Fallback model's Provider is not available in this Agent's scope.",
    };
  }

  const resolved = resolveModelId(provider, fallback.modelId);
  if (!resolved) {
    return {
      error: `The Fallback model '${fallback.modelId}' is not enabled for provider '${provider.name}'.`,
    };
  }

  const primaryProvider = await providerInScope(scope, primary.providerId);
  if (
    primaryProvider?.id === provider.id &&
    resolveModelId(primaryProvider, primary.modelId) === resolved
  ) {
    return { error: FALLBACK_SAME_MODEL_MESSAGE };
  }
  return null;
};

const mergedFallbackPair = (
  existing: AgentRow,
  fields: AgentUpdateFields,
): FallbackPair => ({
  providerId:
    fields.fallbackProviderId !== undefined
      ? (fields.fallbackProviderId ?? null)
      : (existing.fallbackProviderId ?? null),
  modelId:
    fields.fallbackModelId !== undefined
      ? (fields.fallbackModelId ?? null)
      : (existing.fallbackModelId ?? null),
});

export async function createAgent(
  ctx: ScopeContext,
  fields: AgentCreateFields,
): Promise<AgentWriteResult> {
  const data = {
    ...dedupeIdArrays(fields),
    ...normaliseFallbackFields(fields),
  };
  const id = nanoid();

  const fallbackError = await validateFallbackPair(
    { kind: "workspace", ctx },
    { providerId: data.providerId, modelId: data.modelId },
    {
      providerId: data.fallbackProviderId ?? null,
      modelId: data.fallbackModelId ?? null,
    },
  );
  if (fallbackError) return fallbackError;

  if (data.subAgentIds && data.subAgentIds.length > 0) {
    const validation = await validateSubAgentAssignment(
      ctx,
      id,
      data.subAgentIds,
    );
    if (!validation.valid) {
      return { error: validation.error };
    }
  }

  const row = oneRow(
    await db
      .insert(agentTable)
      .values({
        id,
        ...data,
        workspaceId: ctx.workspaceId,
        organizationId: null,
      })
      .returning(),
  );
  return { row };
}

export async function updateAgent(
  scope: AgentScope,
  agentId: string,
  fields: AgentUpdateFields,
): Promise<AgentWriteResult> {
  const data = {
    ...dedupeIdArrays(fields),
    ...normaliseFallbackFields(fields),
  };

  if (scope.kind === "workspace") {
    const { row: existing } = await requireWorkspaceMutable(
      db,
      "agent",
      agentId,
      scope.ctx,
    );

    const fallbackError = await validateFallbackPair(
      { kind: "workspace", ctx: scope.ctx },
      {
        providerId: data.providerId ?? existing.providerId,
        modelId: data.modelId ?? existing.modelId,
      },
      mergedFallbackPair(existing, data),
    );
    if (fallbackError) return fallbackError;

    if (data.subAgentIds) {
      const validation = await validateSubAgentAssignment(
        scope.ctx,
        agentId,
        data.subAgentIds,
      );
      if (!validation.valid) {
        return { error: validation.error };
      }
    }

    const [row] = await db
      .update(agentTable)
      .set({ ...data, updatedAt: new Date() })
      .where(workspaceScopedWhere("agent", agentId, scope.ctx.workspaceId))
      .returning();
    if (!row) throw new NotFoundError("Agent not found");
    return { row };
  }

  const existing = await requireOrgScoped(db, "agent", agentId, scope.orgId);

  if (data.subAgentIds?.includes(agentId)) {
    return { error: SUB_AGENT_SELF_ASSIGNMENT_ERROR };
  }

  if (data.providerId === undefined) {
    throw new Error("A Shared Agent update must carry providerId");
  }
  const fallbackPair = mergedFallbackPair(existing, data);
  const fallbackError = await validateFallbackPair(
    { kind: "organization", orgId: scope.orgId },
    {
      providerId: data.providerId,
      modelId: data.modelId ?? existing.modelId,
    },
    fallbackPair,
  );
  if (fallbackError) return fallbackError;

  const blockers = await findNonSharedReferences(scope.orgId, {
    providerId: data.providerId,
    ...(fallbackPair.providerId
      ? { fallbackProviderId: fallbackPair.providerId }
      : {}),
    skillIds: data.skillIds,
    subAgentIds: data.subAgentIds,
    toolSetIds: data.toolSetIds,
  });
  if (blockers.length > 0) {
    return {
      error:
        "A shared agent may only reference other shared (organization-scoped) resources",
      blockers,
    };
  }

  const [row] = await db
    .update(agentTable)
    .set({ ...data, updatedAt: new Date() })
    .where(orgScopedWhere("agent", agentId, scope.orgId))
    .returning();
  if (!row) throw new NotFoundError("Agent not found");
  return { row };
}

async function requireNoTriggers(agentId: string): Promise<void> {
  const triggers = await db
    .select({ name: triggerTable.name })
    .from(triggerTable)
    .where(eq(triggerTable.agentId, agentId));
  if (triggers.length > 0) {
    throw inUseConflict(
      "agent",
      "trigger",
      triggers.map((t) => t.name),
    );
  }
}

export async function deleteAgent(
  scope: AgentScope,
  agentId: string,
): Promise<void> {
  let where: SQL;
  if (scope.kind === "workspace") {
    await requireWorkspaceMutable(db, "agent", agentId, scope.ctx);
    where = workspaceScopedWhere("agent", agentId, scope.ctx.workspaceId);
  } else {
    await requireSharedDeletable(db, "agent", agentId);
    where = orgScopedWhere("agent", agentId, scope.orgId);
  }
  await requireNoTriggers(agentId);

  const result = await db.transaction(async (tx) => {
    const rows = await tx.delete(agentTable).where(where).returning();
    if (rows.length > 0) {
      await scrubDeletedAgentReference(tx, "subAgentIds", agentId);
    }
    return rows;
  });
  const [deleted] = result;
  if (!deleted) {
    throw new NotFoundError("Agent not found");
  }

  await deleteAvatar(deleted.avatarKey);
}

async function requireAvatarTarget(
  scope: AgentScope,
  agentId: string,
): Promise<{ row: AgentRow; where: SQL }> {
  if (scope.kind === "workspace") {
    const { row } = await requireWorkspaceMutable(
      db,
      "agent",
      agentId,
      scope.ctx,
    );
    return {
      row,
      where: workspaceScopedWhere("agent", agentId, scope.ctx.workspaceId),
    };
  }
  return {
    row: await requireOrgScoped(db, "agent", agentId, scope.orgId),
    where: orgScopedWhere("agent", agentId, scope.orgId),
  };
}

async function writeAvatarKey(
  where: SQL,
  avatarKey: string | null,
): Promise<AgentRow> {
  const [row] = await db
    .update(agentTable)
    .set({ avatarKey, updatedAt: new Date() })
    .where(where)
    .returning();
  if (!row) throw new NotFoundError("Agent not found");
  return row;
}

export async function setAgentAvatar(
  scope: AgentScope,
  agentId: string,
  file: unknown,
): Promise<AgentRow> {
  const { row, where } = await requireAvatarTarget(scope, agentId);
  const stored = await storeAvatar(file, agentId, row.avatarKey);
  if (!stored.ok) throw new ValidationError(stored.error);
  try {
    return await writeAvatarKey(where, stored.key);
  } catch (err) {
    await deleteAvatar(stored.key);
    throw err;
  }
}

export async function clearAgentAvatar(
  scope: AgentScope,
  agentId: string,
): Promise<AgentRow> {
  const { row, where } = await requireAvatarTarget(scope, agentId);
  await deleteAvatar(row.avatarKey);
  return writeAvatarKey(where, null);
}
