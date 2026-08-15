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
import { requireOrgAccess } from "../middleware/authorization.ts";
import { requireSharedDeletable } from "../services/scoped-resource.ts";
import { redactProviderSecrets } from "../services/credential-redaction.ts";
import { NotFoundError } from "../errors.ts";
import type { Variables } from "../server.ts";

const orgProvider = new Hono<{ Variables: Variables }>();

/** Create a new organization provider (admin only) */
orgProvider.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", providerCreateSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const data = c.req.valid("json");

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
        organizationId: orgId,
        workspaceId: null,
      })
      .returning();

    return c.json(record[0], 201);
  },
);

/** List all organization providers */
orgProvider.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const orgId = c.req.param("orgId")!;
  const rows = await db
    .select()
    .from(providerTable)
    .where(eq(providerTable.organizationId, orgId));

  // This route admits any Organization member — a Shared Provider has to be
  // listable to be selected. Only an Org Admin sees its credentials (ADR-0006).
  const isAdmin = c.get("orgMembership")?.role === "admin";
  const results = rows.map((row) =>
    redactProviderSecrets(row, { reveal: isAdmin }),
  );

  return c.json({ results });
});

/** Get an organization provider by ID */
orgProvider.get("/:providerId", requireAuth, requireOrgAccess(), async (c) => {
  const orgId = c.req.param("orgId")!;
  const providerId = c.req.param("providerId");

  const record = await db
    .select()
    .from(providerTable)
    .where(
      and(
        eq(providerTable.id, providerId),
        eq(providerTable.organizationId, orgId),
      ),
    )
    .limit(1);

  if (record.length === 0) {
    throw new NotFoundError("Provider not found");
  }

  // See the list route: credentials are Org-Admin-only (ADR-0006).
  const isAdmin = c.get("orgMembership")?.role === "admin";
  return c.json(redactProviderSecrets(record[0], { reveal: isAdmin }));
});

/** Update an organization provider by ID (admin only) */
orgProvider.put(
  "/:providerId",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", providerUpdateSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const providerId = c.req.param("providerId");
    const data = c.req.valid("json");

    if (data.modelIds) {
      data.modelIds = dedupeModelConfigs(data.modelIds);
    }

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
          eq(providerTable.organizationId, orgId),
        ),
      )
      .returning();

    if (record.length === 0) {
      throw new NotFoundError("Provider not found");
    }

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

/** Delete an organization provider by ID (admin only) */
orgProvider.delete(
  "/:providerId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const providerId = c.req.param("providerId");

    // A Shared resource cannot be deleted while anything still points at it —
    // an Attachment (ADR-0007) or a Blueprint (ADR-0008). Throws ConflictError
    // → 409 via the central onError (ADR-0010).
    await requireSharedDeletable(db, "provider", providerId);

    const result = await db
      .delete(providerTable)
      .where(
        and(
          eq(providerTable.id, providerId),
          eq(providerTable.organizationId, orgId),
        ),
      )
      .returning();

    if (result.length === 0) {
      throw new NotFoundError("Provider not found");
    }

    return c.json({ message: "Provider deleted" });
  },
);

export { orgProvider };
