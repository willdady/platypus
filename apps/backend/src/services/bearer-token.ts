import { createHash, randomBytes } from "node:crypto";
import { and, eq, getTableName, isNull, lt, or } from "drizzle-orm";
import type { BearerTokenStatus } from "@platypus/schemas";
import { db } from "../index.ts";
import {
  a2aToken as a2aTokenTable,
  trigger as triggerTable,
} from "../db/schema.ts";
import { logger } from "../logger.ts";
import { errorMessage } from "../utils/error-message.ts";
import { createNotification } from "./notification.ts";

/**
 * The bearer token an outside caller presents: an Inbound Trigger's
 * (ADR-0030) and an A2A endpoint's (ADR-0032) are made, stored, expired and
 * reported the same way, and that lives here once.
 *
 * Shown to the Owner once and stored only as a hash. Unlike a Webhook's
 * signing secret, which stays readable because HMAC needs it, nothing in
 * Platypus ever needs the token back. It is 256 random bits, so a fast hash is
 * enough: there is no low-entropy input for a slow one to protect.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The tables that hold a token, each with the same token columns. */
type TokenTable = typeof triggerTable | typeof a2aTokenTable;

/**
 * Hashing is also how a presented token is checked: its hash is matched
 * against the stored one. 256 random bits, so a match by hash — in SQL or not
 * — leaks nothing a guess could use, and no constant-time compare is needed.
 */
export const hashBearerToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/**
 * A fresh token, and the hash that is all the database keeps of it. The
 * prefix makes a leaked token recognisable — to a person reading a log, and
 * to a secret scanner — without carrying any meaning the backend relies on.
 */
export const generateBearerToken = (
  prefix: string,
): { token: string; hash: string } => {
  const token = prefix + randomBytes(32).toString("base64url");
  return { token, hash: hashBearerToken(token) };
};

/**
 * The token an `Authorization: Bearer <token>` header carries, or `null`.
 * The header is the only place a token is read from — never the query string,
 * which proxies and access logs record.
 */
export const bearerToken = (header: string | undefined): string | null => {
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
};

/**
 * The columns a newly issued token writes. Clears the notice record, because
 * each expiry Notification is owed once per token.
 */
export const issuedTokenFields = (
  hash: string,
  expiryDays: number,
  now: Date = new Date(),
) => ({
  tokenHash: hash,
  tokenCreatedAt: now,
  tokenExpiresAt: new Date(now.getTime() + expiryDays * DAY_MS),
  tokenNotice: null,
});

/**
 * How a token stands: no token (never issued, or revoked), active, expiring
 * within 7 days, or expired. Every surface that shows it reads this.
 */
export const bearerTokenStatus = (
  token: { tokenHash: string | null; tokenExpiresAt: Date | null },
  now: Date = new Date(),
): BearerTokenStatus => {
  if (!token.tokenHash || !token.tokenExpiresAt) return "none";
  const left = token.tokenExpiresAt.getTime() - now.getTime();
  if (left <= 0) return "expired";
  return left <= 7 * DAY_MS ? "expiring" : "active";
};

/** The columns a revoke writes: no token, and nothing left to notify about. */
export const revokedTokenFields = () => ({
  tokenHash: null,
  tokenCreatedAt: null,
  tokenExpiresAt: null,
  tokenNotice: null,
});

// ----------------------------------------------------------------- last used

const TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map<string, number>();

/** Test seam: forget when each token was last touched. */
export const resetTokenTouches = (): void => lastTouched.clear();

/** Test seam: how many touches are remembered. */
export const tokenTouchCount = (): number => lastTouched.size;

/**
 * Stamps `lastUsedAt` or `lastRejectedAt` on the row `id` names, at most once
 * a minute per row and column, so a flood of calls cannot become a flood of
 * writes. Checked in memory first, so a flood costs no query either; the
 * conditional `WHERE` holds the same limit across instances. Best-effort: a
 * failure is logged, never surfaced to the caller.
 */
export const touchToken = async (
  table: TokenTable,
  id: string,
  column: "lastUsedAt" | "lastRejectedAt",
  now: Date = new Date(),
): Promise<void> => {
  const tableName = getTableName(table);
  const key = `${tableName}:${id}:${column}`;
  const previous = lastTouched.get(key);
  if (previous !== undefined && now.getTime() - previous < TOUCH_INTERVAL_MS) {
    return;
  }
  // Re-inserted so the map stays oldest first; each write then drops expired
  // touches from the front, keeping the map bounded.
  lastTouched.delete(key);
  lastTouched.set(key, now.getTime());
  for (const [staleKey, at] of lastTouched) {
    if (now.getTime() - at < TOUCH_INTERVAL_MS) break;
    lastTouched.delete(staleKey);
  }
  const stamped = table[column];
  try {
    await db
      .update(table)
      .set({ [column]: now })
      .where(
        and(
          eq(table.id, id),
          or(
            isNull(stamped),
            lt(stamped, new Date(now.getTime() - TOUCH_INTERVAL_MS)),
          ),
        ),
      );
  } catch (error) {
    logger.error(
      { table: tableName, id, column, error: errorMessage(error) },
      "Failed to record bearer token use",
    );
  }
};

// ----------------------------------------------------------------- notices

/** A date as a notice body shows it. */
export const noticeDate = (date: Date): string =>
  date.toISOString().slice(0, 10);

/** Where a notice about a token goes: its Workspace, from its Agent. */
export type TokenOwner = {
  orgId: string;
  workspaceId: string;
  agentId: string;
};

/**
 * Posts a Notification to the token's Workspace, from its Agent. `false` —
 * logged — when it could not be posted, so a notice claimed for it can be
 * handed back and sent again.
 */
export const notifyTokenOwner = async (
  owner: TokenOwner,
  title: string,
  body: string,
): Promise<boolean> => {
  try {
    await createNotification(db, owner, { title, body });
    return true;
  } catch (error) {
    logger.error(
      { ...owner, title, error: errorMessage(error) },
      "Failed to notify the Workspace Owner about a bearer token",
    );
    return false;
  }
};

/**
 * The expiry Notifications a token can be owed, in the order they fall due.
 * `tokenNotice` stores the latest one sent, so "has X been sent" is "is the
 * stored notice at or past X".
 */
export const TOKEN_NOTICES = ["expiring_30", "expiring_7", "expired"] as const;

export type TokenNotice = (typeof TOKEN_NOTICES)[number];

export const tokenNoticeSent = (
  stored: string | null,
  notice: TokenNotice,
): boolean =>
  stored != null &&
  TOKEN_NOTICES.indexOf(stored as TokenNotice) >= TOKEN_NOTICES.indexOf(notice);

/**
 * The expiry reminder a token is owed at `now`, if any: 7 days before expiry,
 * or 30 days before it until the 7-day one falls due. A reminder whose moment
 * falls at or before the token was issued is skipped, so a 30-day token only
 * ever gets the 7-day one.
 */
export const dueReminder = (
  token: { tokenCreatedAt: Date | null; tokenExpiresAt: Date },
  now: Date,
): Extract<TokenNotice, "expiring_30" | "expiring_7"> | null => {
  const expires = token.tokenExpiresAt.getTime();
  const created = token.tokenCreatedAt?.getTime() ?? -Infinity;
  const left = expires - now.getTime();
  if (left <= 0) return null;
  const at = (days: number) => expires - days * DAY_MS;
  if (left <= 7 * DAY_MS) return at(7) > created ? "expiring_7" : null;
  if (left <= 30 * DAY_MS) return at(30) > created ? "expiring_30" : null;
  return null;
};

/**
 * Moves the token's notice from `from` to `to`, conditional on both and on
 * the hash, so two instances can't both send it and a regenerated token
 * doesn't inherit it. `true` when this call made the move.
 */
const moveNotice = async (
  table: TokenTable,
  token: { id: string; tokenHash: string },
  from: string | null,
  to: string | null,
): Promise<boolean> => {
  const moved = await db
    .update(table)
    .set({ tokenNotice: to })
    .where(
      and(
        eq(table.id, token.id),
        eq(table.tokenHash, token.tokenHash),
        from === null ? isNull(table.tokenNotice) : eq(table.tokenNotice, from),
      ),
    )
    .returning({ id: table.id });
  return moved.length > 0;
};

/**
 * Sends `notice` about a token, once: claims it on the token's row, posts it,
 * and hands the claim back if posting failed, so the next sweep — or the next
 * call with an expired token — sends it after all. Deleting the Notification
 * never brings it back. Never throws.
 */
export const sendTokenNotice = async (
  table: TokenTable,
  token: { id: string; tokenHash: string; tokenNotice: string | null },
  notice: TokenNotice,
  owner: TokenOwner,
  title: string,
  body: string,
): Promise<void> => {
  const previous = token.tokenNotice;
  try {
    if (!(await moveNotice(table, token, previous, notice))) return;
    if (!(await notifyTokenOwner(owner, title, body))) {
      await moveNotice(table, token, notice, previous);
    }
  } catch (error) {
    logger.error(
      {
        table: getTableName(table),
        id: token.id,
        notice,
        error: errorMessage(error),
      },
      "Failed to send a bearer token notice",
    );
  }
};
