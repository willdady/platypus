import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  provider as providerTable,
  attachment as attachmentTable,
} from "../db/schema.ts";
import { providerCreateSchema, providerUpdateSchema } from "@platypus/schemas";
import { eq, and } from "drizzle-orm";
import { handleEmbeddingConfigChange } from "../services/embedding-invalidation.ts";
import { dedupeArray } from "../utils.ts";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess } from "../middleware/authorization.ts";
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
      data.modelIds = dedupeArray(data.modelIds).sort();
    }

    try {
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
    } catch (error: any) {
      const isUniqueViolation =
        error.code === "23505" ||
        error.cause?.code === "23505" ||
        error.message?.includes("unique constraint") ||
        error.cause?.message?.includes("unique constraint");

      if (isUniqueViolation) {
        return c.json(
          {
            error:
              "A provider with this name already exists in this organization",
          },
          409,
        );
      }
      throw error;
    }
  },
);

/** List all organization providers */
orgProvider.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const orgId = c.req.param("orgId")!;
  const results = await db
    .select()
    .from(providerTable)
    .where(eq(providerTable.organizationId, orgId));

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
    return c.json({ error: "Provider not found" }, 404);
  }

  return c.json(record[0]);
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
      data.modelIds = dedupeArray(data.modelIds).sort();
    }

    // Detect and handle embedding config changes before the update
    await handleEmbeddingConfigChange(providerId, data);

    try {
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
        return c.json({ error: "Provider not found" }, 404);
      }

      return c.json(record[0], 200);
    } catch (error: any) {
      const isUniqueViolation =
        error.code === "23505" ||
        error.cause?.code === "23505" ||
        error.message?.includes("unique constraint") ||
        error.cause?.message?.includes("unique constraint");

      if (isUniqueViolation) {
        return c.json(
          {
            error:
              "A provider with this name already exists in this organization",
          },
          409,
        );
      }
      throw error;
    }
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

    // A Shared resource cannot be deleted while any Attachment references it
    // (ADR-0007) — detach it from every Workspace first.
    const [attached] = await db
      .select()
      .from(attachmentTable)
      .where(
        and(
          eq(attachmentTable.resourceType, "provider"),
          eq(attachmentTable.resourceId, providerId),
        ),
      )
      .limit(1);
    if (attached) {
      return c.json(
        {
          error:
            "Cannot delete: this provider is attached to one or more workspaces. Detach it first.",
        },
        409,
      );
    }

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
      return c.json({ error: "Provider not found" }, 404);
    }

    return c.json({ message: "Provider deleted" });
  },
);

export { orgProvider };
