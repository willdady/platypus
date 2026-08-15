import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { provider as providerTable } from "../db/schema.ts";
import { providerCreateSchema, providerUpdateSchema } from "@platypus/schemas";
import { eq, and } from "drizzle-orm";
import { handleEmbeddingConfigChange } from "../services/embedding-invalidation.ts";
import { dedupeModelConfigs } from "../services/model-capability.ts";
import {
  currentProviderModels,
  deMigrateOrphanedAliases,
} from "../services/model-alias-migration.ts";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess,
  workspaceCredentialsVisible,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import { providerReadModel } from "../services/credential-redaction.ts";
import {
  listScoped,
  requireScoped,
  requireWorkspaceMutable,
} from "../services/scoped-resource.ts";
import type { Variables } from "../server.ts";

const provider = new Hono<{ Variables: Variables }>();

/**
 * Create a workspace-scoped provider. Org-admin by default; a workspace owner
 * may create one only when the workspace's `providerSelfManagement` flag is set
 * (ADR-0006).
 */
provider.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess("providerSelfManagement"),
  sValidator("json", providerCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const { workspaceId } = workspaceScopeOf(c);
    if (data.modelIds) {
      data.modelIds = dedupeModelConfigs(data.modelIds);
    }
    // A duplicate name surfaces as a Postgres unique violation, mapped to 409
    // by the central onError (ADR-0010).
    const record = await db
      .insert(providerTable)
      .values({
        id: nanoid(),
        ...data,
        // The scope comes from the route, never the body — as it does for Agents
        // and Skills. Spreading the body let a caller name another Workspace, or
        // set `organizationId` and mint a Shared Provider from the Workspace
        // surface, which only an Org Admin may do (ADR-0006, ADR-0007).
        workspaceId,
        organizationId: null,
      })
      .returning();
    return c.json(record[0], 201);
  },
);

/** List providers visible in this workspace (workspace-scoped + attached org-scoped) */
provider.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const scoped = await listScoped(db, "provider", workspaceScopeOf(c));
    // Credentials are revealed only to a caller who may manage this Provider
    // (ADR-0006) — the same rule the write routes reject on. The rows themselves
    // still list, because selecting a Provider on an Agent or Chat does not
    // require self-management.
    const reveal = await workspaceCredentialsVisible(c, "provider");
    const results = scoped.map(({ row, scope }) =>
      providerReadModel(row, { reveal, scope }),
    );
    return c.json({ results });
  },
);

/** Get a provider by ID (workspace-scoped, or attached org-scoped) */
provider.get(
  "/:providerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const providerId = c.req.param("providerId");

    const found = await requireScoped(
      db,
      "provider",
      providerId,
      workspaceScopeOf(c),
    );
    // See the list route: redacted unless this caller may manage the Provider.
    const reveal = await workspaceCredentialsVisible(c, "provider");
    return c.json(providerReadModel(found.row, { reveal, scope: found.scope }));
  },
);

/** Update a provider by ID (org-admin, or owner when delegated — ADR-0006) */
provider.put(
  "/:providerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess("providerSelfManagement"),
  sValidator("json", providerUpdateSchema),
  async (c) => {
    const scope = workspaceScopeOf(c);
    const providerId = c.req.param("providerId");
    const data = c.req.valid("json");
    if (data.modelIds) {
      data.modelIds = dedupeModelConfigs(data.modelIds);
    }

    // A Shared Provider is a single source of truth edited only on the
    // Organization surface (ADR-0007); requireWorkspaceMutable throws NotFound
    // (→404) when the Provider is not visible here, then Locked (→403) when it
    // is org-scoped.
    await requireWorkspaceMutable(db, "provider", providerId, scope);

    // Detect and handle embedding config changes before the update
    await handleEmbeddingConfigChange(providerId, data);

    // Snapshot the models as stored, so an alias this save removes can
    // de-migrate its references rather than dangling them (ADR-0017).
    const previousModels = data.modelIds
      ? await currentProviderModels(providerId)
      : null;

    // A duplicate name surfaces as a Postgres unique violation, mapped to 409
    // by the central onError (ADR-0010).
    const record = await db
      .update(providerTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(providerTable.id, providerId),
          eq(providerTable.workspaceId, scope.workspaceId),
        ),
      )
      .returning();

    // Runs AFTER the row is written: a failed update must not leave Agents
    // repointed for an alias that still exists.
    const aliasRepoints =
      previousModels && data.modelIds
        ? await deMigrateOrphanedAliases(
            providerId,
            previousModels,
            data.modelIds,
          )
        : [];

    return c.json({ ...record[0], aliasRepoints }, 200);
  },
);

/** Delete a provider by ID (org-admin, or owner when delegated — ADR-0006) */
provider.delete(
  "/:providerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess("providerSelfManagement"),
  async (c) => {
    const scope = workspaceScopeOf(c);
    const providerId = c.req.param("providerId");

    // A Shared Provider is deleted only from the Organization surface
    // (ADR-0007): requireWorkspaceMutable throws NotFound (→404) when the
    // Provider is not visible here, then Locked (→403) when it is org-scoped.
    await requireWorkspaceMutable(db, "provider", providerId, scope);

    await db
      .delete(providerTable)
      .where(
        and(
          eq(providerTable.id, providerId),
          eq(providerTable.workspaceId, scope.workspaceId),
        ),
      );
    return c.json({ message: "Provider deleted" });
  },
);

export { provider };
