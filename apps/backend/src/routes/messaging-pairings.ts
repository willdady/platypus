import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { db } from "../index.ts";
import {
  messagingPairing as pairingTable,
  messagingChannel as channelTable,
} from "../db/schema.ts";
import { messagingPairingConfirmSchema } from "@platypus/schemas";
import { eq, and, isNotNull } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceOwner,
} from "../middleware/authorization.ts";
import { confirmPairing } from "../messaging/pairing.ts";
import type { Variables } from "../server.ts";

const messagingPairing = new Hono<{ Variables: Variables }>();

/** Confirm a pairing code */
messagingPairing.post(
  "/confirm",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const user = c.get("user")!;

    const body = await c.req.json();
    const parsed = messagingPairingConfirmSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ message: "Invalid pairing code format" }, 400);
    }

    const pairing = await confirmPairing(
      parsed.data.code,
      user.id,
      workspaceId,
    );

    if (!pairing) {
      return c.json({ message: "Invalid or expired pairing code" }, 400);
    }

    return c.json({
      message: "Account linked successfully",
      pairing: {
        id: pairing.id,
        externalUsername: pairing.externalUsername,
        pairedAt: pairing.pairedAt,
      },
    });
  },
);

/** List paired users for a workspace */
messagingPairing.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;

    // Get all channels for this workspace
    const channels = await db
      .select({ id: channelTable.id })
      .from(channelTable)
      .where(eq(channelTable.workspaceId, workspaceId));

    if (channels.length === 0) {
      return c.json({ results: [] });
    }

    const channelIds = channels.map((ch) => ch.id);

    // Get paired users
    const results = [];
    for (const channelId of channelIds) {
      const pairings = await db
        .select()
        .from(pairingTable)
        .where(
          and(
            eq(pairingTable.channelId, channelId),
            isNotNull(pairingTable.userId),
          ),
        );
      results.push(...pairings);
    }

    return c.json({ results });
  },
);

/** Revoke a pairing */
messagingPairing.delete(
  "/:pairingId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const pairingId = c.req.param("pairingId");
    const workspaceId = c.req.param("workspaceId")!;

    // Verify pairing belongs to a channel in this workspace
    const pairings = await db
      .select()
      .from(pairingTable)
      .where(eq(pairingTable.id, pairingId))
      .limit(1);

    if (pairings.length === 0) {
      return c.json({ message: "Pairing not found" }, 404);
    }

    const channel = await db
      .select()
      .from(channelTable)
      .where(
        and(
          eq(channelTable.id, pairings[0].channelId),
          eq(channelTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (channel.length === 0) {
      return c.json({ message: "Pairing not found" }, 404);
    }

    await db.delete(pairingTable).where(eq(pairingTable.id, pairingId));

    return c.json({ message: "Pairing revoked" });
  },
);

export { messagingPairing };
