import crypto from "node:crypto";
import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { webhook as webhookTable } from "../db/schema.ts";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import {
  requireOwned,
  listOwned,
  updateOwned,
  deleteOwned,
} from "../services/workspace-resource.ts";
import { NotFoundError } from "../errors.ts";
import { webhookCreateSchema, webhookUpdateSchema } from "@platypus/schemas";
import type { Variables } from "../server.ts";

const webhook = new Hono<{ Variables: Variables }>();

function generateSigningSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** GET / — List all webhooks for workspace */
webhook.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);

    const results = await listOwned(db, "webhook", workspaceId, null);

    return c.json({ results });
  },
);

/** POST / — Create a new webhook */
webhook.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", webhookCreateSchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const body = c.req.valid("json" as never) as {
      name: string;
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
      "card.created",
      "card.updated",
      "card.deleted",
    ];

    const now = new Date();
    const record = {
      id: nanoid(),
      workspaceId,
      name: body.name,
      url: body.url,
      signingSecret: generateSigningSecret(),
      headers: body.headers ?? null,
      enabled: body.enabled ?? true,
      events: body.events ?? allEvents,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.insert(webhookTable).values(record).returning();
    return c.json(result[0], 201);
  },
);

/** GET /:webhookId — Get single webhook */
webhook.get(
  "/:webhookId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const webhookId = c.req.param("webhookId");

    const record = await requireOwned(db, "webhook", webhookId, workspaceId);

    return c.json(record);
  },
);

/** PUT /:webhookId — Update webhook */
webhook.put(
  "/:webhookId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", webhookUpdateSchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const webhookId = c.req.param("webhookId");
    const body = c.req.valid("json" as never) as {
      name?: string;
      url?: string;
      headers?: Record<string, string> | null;
      enabled?: boolean;
      events?: string[];
    };

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };
    if (body.name !== undefined) updateData.name = body.name;
    if (body.url !== undefined) updateData.url = body.url;
    if (body.headers !== undefined) updateData.headers = body.headers;
    if (body.enabled !== undefined) updateData.enabled = body.enabled;
    if (body.events !== undefined) updateData.events = body.events;

    const result = await updateOwned(
      db,
      "webhook",
      webhookId,
      workspaceId,
      updateData,
    );

    if (!result) {
      throw new NotFoundError("Webhook not found");
    }

    return c.json(result);
  },
);

/** DELETE /:webhookId — Delete webhook */
webhook.delete(
  "/:webhookId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const webhookId = c.req.param("webhookId");

    const deleted = await deleteOwned(db, "webhook", webhookId, workspaceId);

    if (!deleted) {
      throw new NotFoundError("Webhook not found");
    }

    return c.json({ message: "Webhook deleted" });
  },
);

/** POST /:webhookId/regenerate-secret — Regenerate signing secret */
webhook.post(
  "/:webhookId/regenerate-secret",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const webhookId = c.req.param("webhookId");

    const result = await updateOwned(db, "webhook", webhookId, workspaceId, {
      signingSecret: generateSigningSecret(),
      updatedAt: new Date(),
    });

    if (!result) {
      throw new NotFoundError("Webhook not found");
    }

    return c.json(result);
  },
);

export { webhook };
