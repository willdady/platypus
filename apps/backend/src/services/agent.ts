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

/**
 * The Agent write model: dedupe, sub-agent validation, and the
 * insert/update/delete (with avatar cleanup) both surfaces need. The HTTP
 * routes and the Agent-management Tool set are adapters over it — they parse
 * and authorize their own input, call in here, and shape the result. The two
 * used to carry a copy each and had already drifted apart: the Tool's copy of
 * the sampling params was non-nullable, so an Agent could not clear a
 * temperature it had set, while the route's schema-driven copy could (#263).
 *
 * `updateAgent`/`deleteAgent` also answer the Organization surface
 * (`routes/org-agent.ts`), which used to carry its own copy of the dedupe,
 * self-assignment check, and `findNonSharedReferences` blockers inline (#605).
 *
 * "Not visible here" and "visible but locked" (a Shared Agent, a single
 * source of truth edited only on the Organization surface — ADR-0007) are the
 * cross-cutting errors of ADR-0010: at Workspace scope, `updateAgent`/
 * `deleteAgent` throw them via `requireWorkspaceMutable`, for the route to let
 * bubble to `app.onError` and the Tool to catch and translate to an `{ error
 * }` result. At Organization scope, "not visible here" throws `NotFoundError`
 * via `requireOrgScoped`/`requireSharedDeletable` the same way; there is no
 * "locked" case, since the Organization surface is where a Shared Agent is
 * always editable. A rejected sub-agent assignment or reference-blocker check
 * is surface-specific validation (errors.ts) and so answers inline instead, as
 * `{ error }`.
 */

type AgentRow = typeof agentTable.$inferSelect;

/** The fields a create carries — every field but the id and its scope. */
export type AgentCreateFields = Omit<
  z.infer<typeof agentBaseSchema>,
  | "id"
  | "organizationId"
  | "workspaceId"
  | "avatarUrl"
  | "createdAt"
  | "updatedAt"
>;

/** The fields an update may carry — a partial edit of the same set. */
export type AgentUpdateFields = Partial<AgentCreateFields>;

/**
 * What a rejected write carries — shared with the Tool adapter's own result
 * shape. `blockers` is present only for an Organization-scope rejection: the
 * Agent references a Workspace-private resource a Shared Agent may not
 * reference (ADR-0007), named so the UI can render a fix-this checklist.
 */
export type AgentWriteError = { error: string; blockers?: ReferenceBlocker[] };

export type AgentWriteResult = { row: AgentRow } | AgentWriteError;

/**
 * Which scope a write targets — the Workspace surface (ADR-0006 delegation
 * applies, a Shared row is locked) or the Organization surface (admin-only,
 * writes a Shared row directly). Mirrors `ProviderScope`.
 */
export type AgentScope =
  | { kind: "workspace"; ctx: ScopeContext }
  | { kind: "organization"; orgId: string };

/** The id-array fields both a create and an update may carry, for deduping. */
type IdArrayFields = Pick<
  AgentUpdateFields,
  "toolSetIds" | "skillIds" | "subAgentIds"
>;

/** Dedupes the id arrays a write may carry; fields with none pass through unchanged. */
const dedupeIdArrays = <T extends IdArrayFields>(fields: T): T => ({
  ...fields,
  ...(fields.toolSetIds && { toolSetIds: [...new Set(fields.toolSetIds)] }),
  ...(fields.skillIds && { skillIds: [...new Set(fields.skillIds)] }),
  ...(fields.subAgentIds && {
    subAgentIds: [...new Set(fields.subAgentIds)],
  }),
});

/** A blank reference is "unset", so a form that clears a field stores null. */
const normaliseReference = (
  value: string | null | undefined,
): string | null | undefined =>
  value === undefined ? undefined : value?.trim() ? value : null;

/**
 * The Fallback model's two fields, normalised for a write. A key the caller
 * did not send is absent — an update that never mentions the fallback leaves
 * it as it was — while a key sent blank becomes null, which clears it.
 */
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

/** The Fallback model as the write will leave it, after merging an update. */
type FallbackPair = {
  providerId: string | null;
  modelId: string | null;
};

/** A Provider the Agent's scope can reach, or undefined. */
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

/**
 * Validates the Fallback model a write is about to store (ADR-0043): the pair
 * is complete, its Provider is reachable from the Agent's scope, the model (or
 * alias) is enabled on it, and the pair is not the primary pair in disguise.
 *
 * Runs in the write model rather than the request schema because both adapters
 * — the HTTP routes and the Agent-management Tool — must answer it, and because
 * deciding "the same model" needs the Provider rows: a concrete id and the
 * alias that resolves to it are one model.
 */
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

/** Merges a write's fields onto an existing Agent, for pair validation. */
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

/**
 * Creates a new Workspace-scoped Agent. The Workspace comes from `ctx`, never
 * the body — a Workspace surface only ever creates Workspace-scoped Agents
 * (org-scoped Agents arrive via Promote).
 */
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

/**
 * Updates an Agent at the given scope. At Workspace scope, throws
 * `NotFoundError`/`LockedError` (via `requireWorkspaceMutable`) when the Agent
 * is not visible here or is a Shared Agent edited only on the Organization
 * surface (ADR-0007), then validates `subAgentIds` against what this
 * Workspace can see. At Organization scope, throws `NotFoundError` (via
 * `requireOrgScoped`) when the Agent is not visible, then rejects with
 * `blockers` when the update would leave a Shared Agent referencing a
 * Workspace-private resource (ADR-0007's no-cascade rule).
 */
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

  // A Shared Agent may reference only other Shared resources (ADR-0007).
  // `providerId` is required by `agentUpdateSchema` on this surface (unlike
  // the Workspace surface's Tool adapter, which allows a partial update), so
  // it is always present here despite `AgentUpdateFields` widening it to
  // optional for that other caller.
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
    // Only named when the Agent has a fallback, so an Agent without one is
    // checked for exactly the references it has.
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

/**
 * Throws `ConflictError` naming every Trigger that still runs this Agent —
 * `trigger.agent_id` is an `ON DELETE RESTRICT` foreign key, so the delete
 * would otherwise fail in Postgres with nothing the user could act on.
 */
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

/**
 * Deletes an Agent at the given scope, cleaning up its avatar and scrubbing
 * its id from other Agents' `subAgentIds` in the same transaction as the
 * delete (the reference is a jsonb id with no foreign key to cascade). At
 * Workspace scope, throws `NotFoundError`/`LockedError` (via
 * `requireWorkspaceMutable`) under the same rule as {@link updateAgent}. At
 * Organization scope, throws `ConflictError` (via `requireSharedDeletable`)
 * while an Attachment or Blueprint still references the Agent
 * (ADR-0007/0008). At either scope, then throws `ConflictError` while a
 * Trigger still runs the Agent.
 */
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
  // Workspace scope: requireWorkspaceMutable already established the row
  // exists. Organization scope: requireSharedDeletable only checks
  // referencing Attachments/Blueprints, not existence, so the delete itself is
  // where a missing Agent 404s.
  const [deleted] = result;
  if (!deleted) {
    throw new NotFoundError("Agent not found");
  }

  // Best-effort, and only once the delete has committed: a storage miss must
  // not fail it, and a refused delete must not lose the avatar.
  await deleteAvatar(deleted.avatarKey);
}

/**
 * Resolves an Agent for an avatar write at the given scope, under the same
 * visibility and lock rules as {@link updateAgent}, with the predicate the
 * write targets.
 */
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

/** Persists `avatarKey`, throwing `NotFoundError` if the Agent is gone. */
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

/**
 * Validates and stores an uploaded avatar, then persists its key on the
 * Agent. Throws as {@link updateAgent} does when the Agent is not visible or
 * locked at this scope, and `NotFoundError` when it is deleted mid-request
 * (the just-stored avatar is removed first). Throws `ValidationError` for a
 * rejected upload.
 *
 * @param file - The raw value pulled from `parseBody()` — validated by `storeAvatar`.
 */
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

/**
 * Removes an Agent's avatar from storage and clears its key. Throws as
 * {@link setAgentAvatar} does.
 */
export async function clearAgentAvatar(
  scope: AgentScope,
  agentId: string,
): Promise<AgentRow> {
  const { row, where } = await requireAvatarTarget(scope, agentId);
  await deleteAvatar(row.avatarKey);
  return writeAvatarKey(where, null);
}
