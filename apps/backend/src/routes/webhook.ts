import crypto from "node:crypto";
import { Hono } from "hono";
import { validate } from "../validate.ts";
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
import { webhookCreateSchema, webhookUpdateSchema } from "@platypus/schemas";
import type { Variables } from "../server.ts";

const webhook = new Hono<{ Variables: Variables }>();

function generateSigningSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

async function assertDeliverable(url: string): Promise<void> {
  const egress = await checkEgress(url);
  if (!egress.allowed) {
    logger.warn(
      { url, reason: egress.reason },
      "Rejected a webhook URL by network policy",
    );
    throw new ValidationError(
      "This URL can't be reached from this deployment, or isn't permitted by its network policy.",
    );
  }
}

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

webhook.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate("json", webhookCreateSchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const body = c.req.valid("json");

    await assertDeliverable(body.url);

    const now = new Date();
    const record = {
      id: nanoid(),
      workspaceId,
      name: body.name,
      url: body.url,
      signingSecret: generateSigningSecret(),
      headers: body.headers,
      enabled: body.enabled,
      events: body.events,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.insert(webhookTable).values(record).returning();
    return c.json(result[0], 201);
  },
);

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

webhook.patch(
  "/:webhookId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate("json", webhookUpdateSchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const webhookId = c.req.param("webhookId");
    const body = c.req.valid("json");

    if (body.url !== undefined) await assertDeliverable(body.url);

    const result = await updateOwned(
      db,
      "webhook",
      { id: webhookId, workspaceId },
      { ...body, updatedAt: new Date() },
    );

    if (!result) {
      throw new NotFoundError("Webhook not found");
    }

    return c.json(result);
  },
);

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
