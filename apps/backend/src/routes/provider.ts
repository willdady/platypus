import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { provider as providerTable } from "../db/schema.ts";
import { providerCreateSchema, providerUpdateSchema } from "@platypus/schemas";
import { eq, and, or } from "drizzle-orm";
import { dedupeArray } from "../utils.ts";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

const provider = new Hono<{ Variables: Variables }>();

/** Create a new provider (admin only) */
provider.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", providerCreateSchema),
  async (c) => {
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
            message:
              "A provider with this name already exists in this workspace",
          },
          409,
        );
      }
      throw error;
    }
  },
);

/** List all providers (workspace + org-scoped) */
provider.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;

    // Get workspace-scoped providers
    const workspaceProviders = await db
      .select()
      .from(providerTable)
      .where(eq(providerTable.workspaceId, workspaceId));

    // Get org-scoped providers
    const orgProviders = await db
      .select()
      .from(providerTable)
      .where(eq(providerTable.organizationId, orgId));

    // Tag providers with their scope for frontend
    const results = [
      ...orgProviders.map((p) => ({ ...p, scope: "organization" as const })),
      ...workspaceProviders.map((p) => ({ ...p, scope: "workspace" as const })),
    ];

    return c.json({ results });
  },
);

/** Get a provider by ID */
provider.get(
  "/:providerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    const providerId = c.req.param("providerId");

    const record = await db
      .select()
      .from(providerTable)
      .where(
        and(
          eq(providerTable.id, providerId),
          or(
            eq(providerTable.workspaceId, workspaceId),
            eq(providerTable.organizationId, orgId),
          ),
        ),
      )
      .limit(1);

    if (record.length === 0) {
      return c.json({ message: "Provider not found" }, 404);
    }

    const p = record[0];
    const scope = p.organizationId ? "organization" : "workspace";

    return c.json({ ...p, scope });
  },
);

/** Update a provider by ID (admin only) */
provider.put(
  "/:providerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", providerUpdateSchema),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const providerId = c.req.param("providerId");
    const data = c.req.valid("json");
    if (data.modelIds) {
      data.modelIds = dedupeArray(data.modelIds).sort();
    }
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
            eq(providerTable.workspaceId, workspaceId),
          ),
        )
        .returning();
      return c.json(record, 200);
    } catch (error: any) {
      const isUniqueViolation =
        error.code === "23505" ||
        error.cause?.code === "23505" ||
        error.message?.includes("unique constraint") ||
        error.cause?.message?.includes("unique constraint");

      if (isUniqueViolation) {
        return c.json(
          {
            message:
              "A provider with this name already exists in this workspace",
          },
          409,
        );
      }
      throw error;
    }
  },
);

/** Delete a provider by ID (admin only) */
provider.delete(
  "/:providerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const providerId = c.req.param("providerId");
    await db
      .delete(providerTable)
      .where(
        and(
          eq(providerTable.id, providerId),
          eq(providerTable.workspaceId, workspaceId),
        ),
      );
    return c.json({ message: "Provider deleted" });
  },
);

export { provider };
