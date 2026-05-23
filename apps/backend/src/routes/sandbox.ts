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
import { destroySandboxRow } from "../sandbox/teardown.ts";
import { logger } from "../logger.ts";

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

// Update the workspace's sandbox. Hybrid semantics: `name` and `backend` are
// required and always overwritten; `config` and `credentials` are optional
// and preserved when omitted (Drizzle treats undefined as "skip column"),
// which is necessary because GET responses strip credentials so the
// frontend can't re-send them.
//
// Changing `backend` is treated as destroy-then-update per ADR-0001: the
// previous adapter's destroy() is fired inline against the old row before
// the new backend is written. Pass ?force=true to skip the destroy and
// switch anyway (external resources may leak; logged as a warning).
sandbox.put(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", sandboxUpdateSchema),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const data = c.req.valid("json");
    const force = c.req.query("force") === "true";

    const existing = await db
      .select()
      .from(sandboxTable)
      .where(eq(sandboxTable.workspaceId, workspaceId))
      .limit(1);
    if (existing.length === 0) {
      return c.json({ error: "Sandbox not configured" }, 404);
    }

    const backendChanging = existing[0].backend !== data.backend;
    if (backendChanging && !force) {
      try {
        await destroySandboxRow(existing[0]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { workspaceId, sandboxId: existing[0].id, err },
          "Sandbox backend change blocked: previous adapter's destroy() failed",
        );
        return c.json(
          {
            error: `Failed to destroy previous sandbox: ${message}. Pass ?force=true to switch backend anyway (external resources may leak).`,
          },
          500,
        );
      }
    } else if (backendChanging && force) {
      logger.warn(
        {
          workspaceId,
          sandboxId: existing[0].id,
          oldBackend: existing[0].backend,
          newBackend: data.backend,
        },
        "Sandbox backend force-changed; previous adapter's destroy() was skipped — external resources may leak",
      );
    }

    const record = await db
      .update(sandboxTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(sandboxTable.workspaceId, workspaceId))
      .returning();
    return c.json(sanitizeSandboxResponse(record[0]));
  },
);

// Delete the workspace's sandbox. Sync, fail-loud per ADR-0001: the adapter's
// destroy() runs inline and the row is only removed on success. Pass
// `?force=true` to skip destroy() and remove the row anyway — external
// resources may leak; logged as a warning.
sandbox.delete(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const force = c.req.query("force") === "true";

    const existing = await db
      .select()
      .from(sandboxTable)
      .where(eq(sandboxTable.workspaceId, workspaceId))
      .limit(1);
    if (existing.length === 0) {
      return c.json({ error: "Sandbox not configured" }, 404);
    }

    if (!force) {
      try {
        await destroySandboxRow(existing[0]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { workspaceId, sandboxId: existing[0].id, err },
          "Sandbox destroy() failed; row preserved so the user can retry",
        );
        return c.json(
          {
            error: `Failed to destroy sandbox: ${message}. Pass ?force=true to delete the row anyway (external resources may leak).`,
          },
          500,
        );
      }
    } else {
      logger.warn(
        {
          workspaceId,
          sandboxId: existing[0].id,
          backend: existing[0].backend,
        },
        "Sandbox row force-deleted; adapter destroy() was skipped — external resources may leak",
      );
    }

    await db
      .delete(sandboxTable)
      .where(eq(sandboxTable.workspaceId, workspaceId));
    return c.json({ message: "Sandbox deleted" });
  },
);

export { sandbox };
