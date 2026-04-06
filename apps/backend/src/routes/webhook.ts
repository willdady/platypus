import crypto from "node:crypto";
import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import { webhook as webhookTable } from "../db/schema.ts";
import { webhookCreateSchema, webhookUpdateSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

const webhook = new Hono<{ Variables: Variables }>();

function generateSigningSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** GET / — Get webhook config */
webhook.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;

    const results = await db
      .select()
      .from(webhookTable)
      .where(eq(webhookTable.workspaceId, workspaceId))
      .limit(1);

    if (results.length === 0) {
      return c.json({ message: "No webhook configured" }, 404);
    }

    return c.json(results[0]);
  },
);

/** POST / — Create webhook */
webhook.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", webhookCreateSchema),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const body = c.req.valid("json" as never) as {
      url: string;
      headers?: Record<string, string> | null;
      enabled?: boolean;
      events?: string[];
    };

    const allEvents = [
      "notification.created",
      "notification.updated",
      "notification.read",
      "notification.dismissed",
    ];

    const now = new Date();
    const record = {
      id: nanoid(),
      workspaceId,
      url: body.url,
      signingSecret: generateSigningSecret(),
      headers: body.headers ?? null,
      enabled: body.enabled ?? true,
      events: body.events ?? allEvents,
      createdAt: now,
      updatedAt: now,
    };

    try {
      const result = await db
        .insert(webhookTable)
        .values(record)
        .returning();
      return c.json(result[0], 201);
    } catch (error: any) {
      if (error?.cause?.code === "23505") {
        return c.json(
          { message: "A webhook already exists for this workspace" },
          409,
        );
      }
      throw error;
    }
  },
);

/** PUT / — Update webhook */
webhook.put(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", webhookUpdateSchema),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const body = c.req.valid("json" as never) as {
      url?: string;
      headers?: Record<string, string> | null;
      enabled?: boolean;
      events?: string[];
    };

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };
    if (body.url !== undefined) updateData.url = body.url;
    if (body.headers !== undefined) updateData.headers = body.headers;
    if (body.enabled !== undefined) updateData.enabled = body.enabled;
    if (body.events !== undefined) updateData.events = body.events;

    const result = await db
      .update(webhookTable)
      .set(updateData)
      .where(eq(webhookTable.workspaceId, workspaceId))
      .returning();

    if (result.length === 0) {
      return c.json({ message: "No webhook configured" }, 404);
    }

    return c.json(result[0]);
  },
);

/** DELETE / — Delete webhook */
webhook.delete(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;

    const result = await db
      .delete(webhookTable)
      .where(eq(webhookTable.workspaceId, workspaceId))
      .returning();

    if (result.length === 0) {
      return c.json({ message: "No webhook configured" }, 404);
    }

    return c.json({ message: "Webhook deleted" });
  },
);

/** POST /regenerate-secret — Regenerate signing secret */
webhook.post(
  "/regenerate-secret",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;

    const result = await db
      .update(webhookTable)
      .set({
        signingSecret: generateSigningSecret(),
        updatedAt: new Date(),
      })
      .where(eq(webhookTable.workspaceId, workspaceId))
      .returning();

    if (result.length === 0) {
      return c.json({ message: "No webhook configured" }, 404);
    }

    return c.json(result[0]);
  },
);

export { webhook };
