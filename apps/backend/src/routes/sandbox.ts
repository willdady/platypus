import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import { sandbox as sandboxTable } from "../db/schema.ts";
import { sandboxCreateSchema, sandboxUpdateSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

type SandboxRecord = typeof sandboxTable.$inferSelect;

const sandbox = new Hono<{ Variables: Variables }>();

// Credentials are server-side only. Stripping here is a quiet improvement over
// the Provider/MCP routes which still return their secret fields; revisit when
// those routes adopt a similar redaction pattern.
const sanitizeSandboxResponse = (record: SandboxRecord) => {
  const { credentials: _credentials, ...rest } = record;
  return rest;
};

/** Get the workspace's sandbox (404 if none configured) */
sandbox.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const record = await db
      .select()
      .from(sandboxTable)
      .where(eq(sandboxTable.workspaceId, workspaceId))
      .limit(1);
    if (record.length === 0) {
      return c.json({ error: "Sandbox not configured" }, 404);
    }
    return c.json(sanitizeSandboxResponse(record[0]));
  },
);

/** Create the workspace's sandbox (409 if one already exists) */
sandbox.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", sandboxCreateSchema),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const data = c.req.valid("json");

    const existing = await db
      .select()
      .from(sandboxTable)
      .where(eq(sandboxTable.workspaceId, workspaceId))
      .limit(1);
    if (existing.length > 0) {
      return c.json(
        { error: "Sandbox already configured for this workspace" },
        409,
      );
    }

    const record = await db
      .insert(sandboxTable)
      .values({
        id: nanoid(),
        ...data,
        workspaceId,
      })
      .returning();
    return c.json(sanitizeSandboxResponse(record[0]), 201);
  },
);

/** Update the workspace's sandbox (404 if none configured) */
sandbox.put(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", sandboxUpdateSchema),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const data = c.req.valid("json");
    const record = await db
      .update(sandboxTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(sandboxTable.workspaceId, workspaceId))
      .returning();
    if (record.length === 0) {
      return c.json({ error: "Sandbox not configured" }, 404);
    }
    return c.json(sanitizeSandboxResponse(record[0]));
  },
);

/** Delete the workspace's sandbox (404 if none configured) */
sandbox.delete(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    // Note: this does not yet invoke the adapter's destroy() — external
    // resources will leak until the teardown slice (ADR-0001) lands.
    const result = await db
      .delete(sandboxTable)
      .where(eq(sandboxTable.workspaceId, workspaceId))
      .returning();
    if (result.length === 0) {
      return c.json({ error: "Sandbox not configured" }, 404);
    }
    return c.json({ message: "Sandbox deleted" });
  },
);

export { sandbox };
