import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { messagingChannel as channelTable } from "../db/schema.ts";
import {
  messagingChannelCreateSchema,
  messagingChannelUpdateSchema,
} from "@platypus/schemas";
import { eq, and, ne, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceOwner,
} from "../middleware/authorization.ts";
import { messagingProviderManager } from "../messaging/manager.ts";
import { logger } from "../logger.ts";
import type { Variables } from "../server.ts";

const messagingChannel = new Hono<{ Variables: Variables }>();

/**
 * Sanitize bot token in config - show only last 4 characters.
 */
const sanitizeConfig = (
  config: Record<string, unknown>,
): Record<string, unknown> => {
  const sanitized = { ...config };
  if (typeof sanitized.botToken === "string" && sanitized.botToken.length > 4) {
    sanitized.botToken =
      "*".repeat(sanitized.botToken.length - 4) + sanitized.botToken.slice(-4);
  }
  return sanitized;
};

/**
 * Validate a Telegram bot token by calling the getMe API.
 * Returns ok: true if the token is valid OR if the API is unreachable
 * (we only reject when Telegram explicitly says the token is invalid).
 */
const validateTelegramToken = async (
  botToken: string,
): Promise<{ ok: boolean; username?: string; error?: string }> => {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/getMe`,
    );
    const data = await response.json();
    if (data.ok) {
      return { ok: true, username: data.result.username };
    }
    return { ok: false, error: data.description || "Invalid bot token" };
  } catch (error) {
    // Network error — don't block channel creation, token will be validated
    // when the bot actually starts polling
    logger.warn(
      { error },
      "Could not reach Telegram API to validate bot token, skipping validation",
    );
    return { ok: true };
  }
};

/**
 * Check if a bot token is already used by another channel.
 */
const checkDuplicateToken = async (
  botToken: string,
  excludeChannelId?: string,
): Promise<boolean> => {
  const conditions = [sql`${channelTable.config}->>'botToken' = ${botToken}`];
  if (excludeChannelId) {
    conditions.push(ne(channelTable.id, excludeChannelId));
  }

  const results = await db
    .select({ id: channelTable.id })
    .from(channelTable)
    .where(and(...conditions))
    .limit(1);

  return results.length > 0;
};

/** Create a new messaging channel */
messagingChannel.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", messagingChannelCreateSchema),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const data = c.req.valid("json");

    // Validate bot token for Telegram
    if (data.type === "telegram") {
      const botToken = data.config.botToken;

      // Check for duplicate token
      const isDuplicate = await checkDuplicateToken(botToken);
      if (isDuplicate) {
        return c.json(
          { message: "This bot token is already in use by another workspace" },
          409,
        );
      }

      // Validate token via Telegram API
      const validation = await validateTelegramToken(botToken);
      if (!validation.ok) {
        return c.json(
          { message: `Invalid bot token: ${validation.error}` },
          400,
        );
      }
    }

    try {
      const record = await db
        .insert(channelTable)
        .values({
          id: nanoid(),
          workspaceId,
          type: data.type,
          config: data.config,
          enabled: data.enabled ?? false,
        })
        .returning();

      const channel = record[0];

      // Start the bot if enabled
      if (channel.enabled) {
        try {
          await messagingProviderManager.startChannel(channel);
        } catch (error) {
          logger.error(
            { error, channelId: channel.id },
            "Failed to start messaging channel after creation",
          );
        }
      }

      return c.json(
        {
          ...channel,
          config: sanitizeConfig(channel.config as Record<string, unknown>),
        },
        201,
      );
    } catch (error: any) {
      const isUniqueViolation =
        error.code === "23505" ||
        error.cause?.code === "23505" ||
        error.message?.includes("unique constraint") ||
        error.cause?.message?.includes("unique constraint");

      if (isUniqueViolation) {
        return c.json(
          {
            message: "A channel of this type already exists for this workspace",
          },
          409,
        );
      }
      throw error;
    }
  },
);

/** List all messaging channels for a workspace */
messagingChannel.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;

    const results = await db
      .select()
      .from(channelTable)
      .where(eq(channelTable.workspaceId, workspaceId));

    const sanitized = results.map((r) => ({
      ...r,
      config: sanitizeConfig(r.config as Record<string, unknown>),
    }));

    return c.json({ results: sanitized });
  },
);

/** Get a messaging channel by ID */
messagingChannel.get(
  "/:channelId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const channelId = c.req.param("channelId");

    const record = await db
      .select()
      .from(channelTable)
      .where(
        and(
          eq(channelTable.id, channelId),
          eq(channelTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (record.length === 0) {
      return c.json({ message: "Channel not found" }, 404);
    }

    return c.json({
      ...record[0],
      config: sanitizeConfig(record[0].config as Record<string, unknown>),
    });
  },
);

/** Update a messaging channel */
messagingChannel.patch(
  "/:channelId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", messagingChannelUpdateSchema),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const channelId = c.req.param("channelId");
    const data = c.req.valid("json");

    // Fetch current channel
    const existing = await db
      .select()
      .from(channelTable)
      .where(
        and(
          eq(channelTable.id, channelId),
          eq(channelTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      return c.json({ message: "Channel not found" }, 404);
    }

    const current = existing[0];
    const currentConfig = current.config as Record<string, unknown>;

    // Validate new bot token if changed
    if (
      data.config?.botToken &&
      data.config.botToken !== currentConfig.botToken
    ) {
      const isDuplicate = await checkDuplicateToken(
        data.config.botToken,
        channelId,
      );
      if (isDuplicate) {
        return c.json(
          { message: "This bot token is already in use by another workspace" },
          409,
        );
      }

      const validation = await validateTelegramToken(data.config.botToken);
      if (!validation.ok) {
        return c.json(
          { message: `Invalid bot token: ${validation.error}` },
          400,
        );
      }
    }

    // Build update payload
    const updatePayload: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (data.config !== undefined) {
      updatePayload.config = data.config;
    }
    if (data.enabled !== undefined) {
      updatePayload.enabled = data.enabled;
    }

    const record = await db
      .update(channelTable)
      .set(updatePayload)
      .where(
        and(
          eq(channelTable.id, channelId),
          eq(channelTable.workspaceId, workspaceId),
        ),
      )
      .returning();

    const updated = record[0];

    // Handle bot lifecycle changes
    const configChanged =
      data.config !== undefined &&
      JSON.stringify(data.config) !== JSON.stringify(currentConfig);
    const enabledChanged =
      data.enabled !== undefined && data.enabled !== current.enabled;

    if (configChanged && updated.enabled) {
      // Config changed while enabled - restart
      await messagingProviderManager.restartChannel(updated);
    } else if (enabledChanged) {
      if (updated.enabled) {
        await messagingProviderManager.startChannel(updated);
      } else {
        await messagingProviderManager.stopChannel(channelId);
      }
    }

    return c.json({
      ...updated,
      config: sanitizeConfig(updated.config as Record<string, unknown>),
    });
  },
);

/** Delete a messaging channel */
messagingChannel.delete(
  "/:channelId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const channelId = c.req.param("channelId");

    // Stop the bot
    await messagingProviderManager.stopChannel(channelId);

    // Delete the channel (cascades to pairings and sessions)
    await db
      .delete(channelTable)
      .where(
        and(
          eq(channelTable.id, channelId),
          eq(channelTable.workspaceId, workspaceId),
        ),
      );

    return c.json({ message: "Channel deleted" });
  },
);

export { messagingChannel };
