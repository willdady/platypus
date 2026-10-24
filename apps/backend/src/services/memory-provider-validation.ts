import { db } from "../index.ts";
import { provider as providerTable } from "../db/schema.ts";
import { ValidationError } from "../errors.ts";
import type { ScopeContext } from "../scope.ts";
import { orgScopedWhereIn, resolveScoped } from "./scoped-resource.ts";

type MemoryProviderSettings = {
  memoryExtractionProviderId?: string | null;
  memoryEmbeddingProviderId?: string | null;
};

type MemoryModels = {
  memoryExtractionModelId: string | null;
  embeddingModelId: string | null;
};

const SLOTS = [
  {
    field: "memoryExtractionProviderId",
    column: "memoryExtractionModelId",
    reason: "does not have a memory extraction model configured",
  },
  {
    field: "memoryEmbeddingProviderId",
    column: "embeddingModelId",
    reason: "does not have an embedding model configured",
  },
] as const;

/**
 * The Providers among `ids` visible in `scope`, by id. A Workspace scope
 * resolves through the Scoped resource authority (ADR-0007) — its own
 * Providers, or Shared ones Attached to it — so an id from another Workspace or
 * Organization is never accepted. An Organization scope (a Blueprint) sees only
 * that Organization's Shared Providers.
 */
const providersInScope = async (
  ids: string[],
  scope: ScopeContext | { orgId: string },
): Promise<Map<string, MemoryModels>> => {
  if ("workspaceId" in scope) {
    const resolved = await Promise.all(
      ids.map((id) => resolveScoped(db, "provider", id, scope)),
    );
    return new Map(
      resolved.flatMap((r) => (r ? [[r.row.id, r.row] as const] : [])),
    );
  }
  const rows = await db
    .select({
      id: providerTable.id,
      memoryExtractionModelId: providerTable.memoryExtractionModelId,
      embeddingModelId: providerTable.embeddingModelId,
    })
    .from(providerTable)
    .where(orgScopedWhereIn("provider", ids, scope.orgId));
  return new Map(rows.map((r) => [r.id, r]));
};

/**
 * Throws `ValidationError` naming every memory Provider setting that points at
 * a Provider not visible in `scope`, or at one lacking the model its slot needs
 * — a Workspace stamped with either would have an unusable memory config.
 */
export const requireMemoryProviderCapable = async (
  data: MemoryProviderSettings,
  scope: ScopeContext | { orgId: string },
): Promise<void> => {
  const checks = SLOTS.flatMap((slot) => {
    const providerId = data[slot.field];
    return providerId ? [{ ...slot, providerId }] : [];
  });
  if (checks.length === 0) return;

  const providers = await providersInScope(
    [...new Set(checks.map((c) => c.providerId))],
    scope,
  );

  const invalid = checks.flatMap((c) => {
    const provider = providers.get(c.providerId);
    if (!provider) return [`${c.field} ${c.providerId} not found`];
    if (!provider[c.column]) return [`${c.field} ${c.providerId} ${c.reason}`];
    return [];
  });
  if (invalid.length > 0) {
    throw new ValidationError(
      `Invalid memory provider settings: ${invalid.join("; ")}`,
    );
  }
};
