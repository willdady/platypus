import { createHash, randomBytes } from "node:crypto";
import { and, eq, getTableName, isNull, lt, or } from "drizzle-orm";
import type { BearerTokenStatus } from "@platypus/schemas";
import { db } from "../index.ts";
import type {
  a2aToken as a2aTokenTable,
  trigger as triggerTable,
} from "../db/schema.ts";
import { logger } from "../logger.ts";
import { errorMessage } from "../utils/error-message.ts";
import { createNotification } from "./notification.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;

const EXPIRING_SOON_DAYS = 7;

type TokenTable = typeof triggerTable | typeof a2aTokenTable;

export const hashBearerToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export const generateBearerToken = (
  prefix: string,
): { token: string; hash: string } => {
  const token = prefix + randomBytes(32).toString("base64url");
  return { token, hash: hashBearerToken(token) };
};

export const bearerToken = (header: string | undefined): string | null => {
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1] ?? null;
};

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

export const bearerTokenStatus = (
  token: { tokenHash: string | null; tokenExpiresAt: Date | null },
  now: Date = new Date(),
): BearerTokenStatus => {
  if (!token.tokenHash || !token.tokenExpiresAt) return "none";
  const left = token.tokenExpiresAt.getTime() - now.getTime();
  if (left <= 0) return "expired";
  return left <= EXPIRING_SOON_DAYS * DAY_MS ? "expiring" : "active";
};

export const revokedTokenFields = () => ({
  tokenHash: null,
  tokenCreatedAt: null,
  tokenExpiresAt: null,
  tokenNotice: null,
});

const TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map<string, number>();

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
  lastTouched.delete(key);
  lastTouched.set(key, now.getTime());
  // why: pruning has no behavioural footprint, so nothing observes its loss; #2140 dropped the size seam that did
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

export const TOKEN_REPLACED_MESSAGE =
  "The token was replaced since you loaded the list. Refresh it and revoke the new one if it should stop too.";

export const noticeDate = (date: Date): string =>
  date.toISOString().slice(0, 10);

type TokenHolder = { workspaceId: string; agentId: string };

export const notifyTokenOwner = async (
  orgId: string,
  { workspaceId, agentId }: TokenHolder,
  title: string,
  body: string,
): Promise<boolean> => {
  const owner = { orgId, workspaceId, agentId };
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

const TOKEN_NOTICES = ["expiring_30", "expiring_7", "expired"] as const;

type TokenNotice = (typeof TOKEN_NOTICES)[number];

const tokenNoticeSent = (stored: string | null, notice: TokenNotice): boolean =>
  stored != null &&
  TOKEN_NOTICES.indexOf(stored as TokenNotice) >= TOKEN_NOTICES.indexOf(notice);

export const dueReminder = (
  token: { tokenCreatedAt: Date | null; tokenExpiresAt: Date },
  now: Date,
): Extract<TokenNotice, "expiring_30" | "expiring_7"> | null => {
  const expires = token.tokenExpiresAt.getTime();
  const created = token.tokenCreatedAt?.getTime() ?? -Infinity;
  const left = expires - now.getTime();
  if (left <= 0) return null;
  const at = (days: number) => expires - days * DAY_MS;
  if (left <= EXPIRING_SOON_DAYS * DAY_MS)
    return at(EXPIRING_SOON_DAYS) > created ? "expiring_7" : null;
  if (left <= 30 * DAY_MS) return at(30) > created ? "expiring_30" : null;
  return null;
};

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

export const sendTokenNotice = async (
  table: TokenTable,
  token: { id: string; tokenHash: string; tokenNotice: string | null },
  notice: TokenNotice,
  orgId: string,
  holder: TokenHolder,
  title: string,
  body: string,
): Promise<void> => {
  const previous = token.tokenNotice;
  if (tokenNoticeSent(previous, notice)) return;
  try {
    if (!(await moveNotice(table, token, previous, notice))) return;
    if (!(await notifyTokenOwner(orgId, holder, title, body))) {
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
