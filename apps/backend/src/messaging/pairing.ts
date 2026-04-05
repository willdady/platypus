import { nanoid, customAlphabet } from "nanoid";
import { and, eq, isNull, lt, isNotNull } from "drizzle-orm";
import { db } from "../index.ts";
import {
  messagingPairing as pairingTable,
  messagingChannel as channelTable,
} from "../db/schema.ts";
import { logger } from "../logger.ts";

const generateCode = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 6);

/**
 * Generates a pairing code for a Telegram user to link their account.
 * If an unexpired, unpaired code already exists for this external chat, returns it.
 */
export const generatePairingCode = async (
  channelId: string,
  externalChatId: string,
  externalUserId: string,
  externalUsername?: string,
): Promise<string> => {
  // Check for existing unexpired, unpaired code for this external chat
  const existing = await db
    .select()
    .from(pairingTable)
    .where(
      and(
        eq(pairingTable.channelId, channelId),
        eq(pairingTable.externalChatId, externalChatId),
        isNull(pairingTable.userId),
        lt(new Date(), pairingTable.expiresAt),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return existing[0].code;
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await db.insert(pairingTable).values({
    id: nanoid(),
    code,
    channelId,
    externalChatId,
    externalUserId,
    externalUsername: externalUsername ?? null,
    expiresAt,
  });

  return code;
};

/**
 * Confirms a pairing code, linking the external user to a Platypus user.
 * Returns the pairing record or null if the code is invalid/expired.
 */
export const confirmPairing = async (
  code: string,
  userId: string,
  workspaceId: string,
): Promise<typeof pairingTable.$inferSelect | null> => {
  // Find valid pairing code
  const pairings = await db
    .select()
    .from(pairingTable)
    .where(
      and(
        eq(pairingTable.code, code.toUpperCase()),
        isNull(pairingTable.userId),
      ),
    )
    .limit(1);

  if (pairings.length === 0) {
    return null;
  }

  const pairing = pairings[0];

  // Check expiry
  if (new Date() > pairing.expiresAt) {
    return null;
  }

  // Verify channel belongs to workspace
  const channels = await db
    .select()
    .from(channelTable)
    .where(
      and(
        eq(channelTable.id, pairing.channelId),
        eq(channelTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (channels.length === 0) {
    return null;
  }

  // Update pairing with user
  const updated = await db
    .update(pairingTable)
    .set({
      userId,
      pairedAt: new Date(),
    })
    .where(eq(pairingTable.id, pairing.id))
    .returning();

  return updated[0];
};

/**
 * Finds a paired user for a given channel and external chat.
 */
export const findPairedUser = async (
  channelId: string,
  externalChatId: string,
): Promise<string | null> => {
  const pairings = await db
    .select()
    .from(pairingTable)
    .where(
      and(
        eq(pairingTable.channelId, channelId),
        eq(pairingTable.externalChatId, externalChatId),
        isNotNull(pairingTable.userId),
      ),
    )
    .limit(1);

  if (pairings.length === 0) {
    return null;
  }

  return pairings[0].userId;
};

/**
 * Cleans up expired, unconfirmed pairing codes.
 */
export const cleanupExpiredPairings = async (): Promise<void> => {
  const deleted = await db
    .delete(pairingTable)
    .where(
      and(isNull(pairingTable.userId), lt(pairingTable.expiresAt, new Date())),
    )
    .returning({ id: pairingTable.id });

  if (deleted.length > 0) {
    logger.info(
      { deletedCount: deleted.length },
      "Cleaned up expired pairing codes",
    );
  }
};
