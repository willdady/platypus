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
import { NotFoundError, ValidationError } from "../errors.ts";
import { checkEgress } from "../utils/egress-guard.ts";
import { logger } from "../logger.ts";
import {
  webhookCreateSchema,
  webhookEventSchema,
  webhookUpdateSchema,
} from "@platypus/schemas";
import type { Variables } from "../server.ts";

const webhook = new Hono<{ Variables: Variables }>();

function generateSigningSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Rejects a URL the delivery-time egress check would block, so the user hears
 * about it on save rather than through deliveries that silently never arrive.
 * Delivery re-checks regardless, since DNS can change after this. The message
 * is uniform for the same reason as the guard's own: the reason goes to the log.
 */
async function assertDeliverable(url: string): Promise<void> {
  const egress = await checkEgress(url);
  if (!egress.allowed) {
    logger.warn(
      { url, reason: egress.reason },
      "Rejected a webhook URL by network policy",
    );
    throw new ValidationError(
      "This URL is not permitted by this deployment's network policy.",
    );
  }
}

/** GET / — List all webhooks for workspace */
webhook.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);

    const results = await listOwned(db, "webhook", { workspaceId }, null);

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

    await assertDeliverable(body.url);

    const now = new Date();
    const record = {
      id: nanoid(),
      workspaceId,
      name: body.name,
      url: body.url,
      signingSecret: generateSigningSecret(),
      headers: body.headers ?? null,
      enabled: body.enabled ?? true,
      // Every event the schema knows, not a hand-kept list: one here once
      // missed `card.moved`.
      events: body.events ?? webhookEventSchema.options,
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

    const record = await requireOwned(db, "webhook", {
      id: webhookId,
      workspaceId,
    });

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

    if (body.url !== undefined) await assertDeliverable(body.url);

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
      { id: webhookId, workspaceId },
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

    const deleted = await deleteOwned(db, "webhook", {
      id: webhookId,
      workspaceId,
    });

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

    const result = await updateOwned(
      db,
      "webhook",
      { id: webhookId, workspaceId },
      {
        signingSecret: generateSigningSecret(),
        updatedAt: new Date(),
      },
    );

    if (!result) {
      throw new NotFoundError("Webhook not found");
    }

    return c.json(result);
  },
);

export { webhook };
