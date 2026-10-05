import { and, eq, gt, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "../index.ts";
import {
  a2aEndpoint as a2aEndpointTable,
  a2aToken as a2aTokenTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { logger } from "../logger.ts";
import { errorMessage } from "../utils/error-message.ts";
import { createNotification } from "./notification.ts";
import { NotFoundError } from "../errors.ts";
import {
  A2A_TOKEN_PREFIX,
  lookupA2aEndpoint,
  toPublicToken,
  type A2aEndpointLookup,
  type A2aEndpointRow,
  type LiveA2aEndpoint,
} from "./a2a-endpoint.ts";
import { requireOwned } from "./workspace-resource.ts";
import { bearerToken, dueReminder } from "./inbound-trigger.ts";
import {
  DAY_MS,
  generateBearerToken,
  hashInboundToken,
  issuedTokenFields,
  tokenNoticeSent,
  type TokenNotice,
} from "./inbound-trigger-token.ts";

/**
 * An A2A token's lifecycle (ADR-0032), which follows an Inbound Trigger's
 * (ADR-0030): it expires, the Owner is reminded 30 and 7 days before and told
 * the first time it is used after, and last used and last rejected are written
 * at most once a minute. Each Notification is claimed on the token row before
 * it is sent, so a peer never repeats one and deleting it never brings it back.
 */

export type A2aTokenRow = typeof a2aTokenTable.$inferSelect;

export type A2aAuthResult =
  | { ok: true; endpoint: LiveA2aEndpoint; token: A2aTokenRow }
  /** `404` is the card's answer for an endpoint that isn't live. */
  | (Extract<A2aEndpointLookup, { live: false }> & { ok: false; status: 404 })
  | {
      ok: false;
      status: 401;
      reason: "missing_token" | "bad_token" | "expired_token";
      endpoint: LiveA2aEndpoint;
      /** The token an expired one names; a missing or wrong one names none. */
      tokenId?: string;
    };

/**
 * Whether a call may reach `endpointId`. An endpoint that isn't live is the
 * card's uniform `404`; on a live one, a missing, wrong or expired token is
 * `401`. Only an expired token names a token, so only it stamps last rejected.
 * Each refusal says why, for the call log.
 */
export const authenticateA2aCall = async (
  endpointId: string,
  authorization: string | undefined,
  now: Date = new Date(),
): Promise<A2aAuthResult> => {
  const lookup = await lookupA2aEndpoint(endpointId);
  if (!lookup.live) return { ...lookup, ok: false, status: 404 };
  const { endpoint } = lookup;

  const presented = bearerToken(authorization);
  if (!presented) {
    return { ok: false, status: 401, reason: "missing_token", endpoint };
  }
  // 256 random bits, so a lookup by hash leaks nothing a guess could use.
  const [token] = await db
    .select()
    .from(a2aTokenTable)
    .where(
      and(
        eq(a2aTokenTable.endpointId, endpointId),
        eq(a2aTokenTable.tokenHash, hashInboundToken(presented)),
      ),
    )
    .limit(1);
  if (!token) return { ok: false, status: 401, reason: "bad_token", endpoint };

  if (token.tokenExpiresAt <= now) {
    await touchA2aToken(token.id, "lastRejectedAt", now);
    await noticeExpiredUse(endpoint, token);
    return {
      ok: false,
      status: 401,
      reason: "expired_token",
      endpoint,
      tokenId: token.id,
    };
  }
  await touchA2aToken(token.id, "lastUsedAt", now);
  return { ok: true, endpoint, token };
};

// ----------------------------------------------------------------- regenerate

/**
 * Issues a new value for the token, with the lifetime it was issued with. The
 * old value stops working at once, and the reminder record is cleared. The
 * new value is in this return value and nowhere else.
 */
export const regenerateA2aToken = async (
  workspaceId: string,
  endpointId: string,
  tokenId: string,
) => {
  await requireOwned(db, "a2aEndpoint", { id: endpointId, workspaceId });
  const [current] = await db
    .select()
    .from(a2aTokenTable)
    .where(
      and(
        eq(a2aTokenTable.id, tokenId),
        eq(a2aTokenTable.endpointId, endpointId),
      ),
    )
    .limit(1);
  if (!current) throw new NotFoundError("A2A token not found");
  const lifetimeDays = Math.round(
    (current.tokenExpiresAt.getTime() - current.tokenCreatedAt.getTime()) /
      DAY_MS,
  );
  const { token, hash } = generateBearerToken(A2A_TOKEN_PREFIX);
  const [row] = await db
    .update(a2aTokenTable)
    .set(issuedTokenFields(hash, lifetimeDays))
    .where(
      and(
        eq(a2aTokenTable.id, tokenId),
        eq(a2aTokenTable.endpointId, endpointId),
      ),
    )
    .returning();
  // Deleted between the read and the write.
  if (!row) throw new NotFoundError("A2A token not found");
  return { ...toPublicToken(row), token };
};

// ----------------------------------------------------------------- last used

const TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map<string, number>();

/** Test seam: forget when each token was last touched. */
export const resetA2aTokenTouches = (): void => lastTouched.clear();

/**
 * Stamps `lastUsedAt` or `lastRejectedAt`, at most once a minute per token:
 * checked in memory first, so a flood costs no query, and by a conditional
 * `WHERE` across instances. Best-effort: a failure is logged, never surfaced.
 */
export const touchA2aToken = async (
  tokenId: string,
  column: "lastUsedAt" | "lastRejectedAt",
  now: Date = new Date(),
): Promise<void> => {
  const key = `${tokenId}:${column}`;
  const previous = lastTouched.get(key);
  if (previous !== undefined && now.getTime() - previous < TOUCH_INTERVAL_MS) {
    return;
  }
  lastTouched.set(key, now.getTime());
  const stamped = a2aTokenTable[column];
  try {
    await db
      .update(a2aTokenTable)
      .set({ [column]: now })
      .where(
        and(
          eq(a2aTokenTable.id, tokenId),
          or(
            isNull(stamped),
            lt(stamped, new Date(now.getTime() - TOUCH_INTERVAL_MS)),
          ),
        ),
      );
  } catch (error) {
    logger.error(
      { tokenId, column, error: errorMessage(error) },
      "Failed to record A2A token use",
    );
  }
};

// ----------------------------------------------------------------- notices

const formatDate = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Posts a Notification to the endpoint's Workspace, from its Agent. `false` —
 * logged — when it could not be posted, so the claimed notice is handed back.
 */
const notifyOwner = async (
  endpoint: Pick<A2aEndpointRow, "id" | "workspaceId" | "agentId">,
  organizationId: string,
  title: string,
  body: string,
): Promise<boolean> => {
  try {
    await createNotification(
      db,
      {
        orgId: organizationId,
        workspaceId: endpoint.workspaceId,
        agentId: endpoint.agentId,
      },
      { title, body },
    );
    return true;
  } catch (error) {
    logger.error(
      { endpointId: endpoint.id, error: errorMessage(error) },
      "Failed to notify the Workspace Owner about an A2A token",
    );
    return false;
  }
};

/**
 * Moves the token's notice from `from` to `to`, conditional on both and on
 * the hash, so two instances can't both send it and a regenerated token
 * doesn't inherit it. `true` when this call made the move.
 */
const moveNotice = async (
  token: Pick<A2aTokenRow, "id" | "tokenHash">,
  from: string | null,
  to: string | null,
): Promise<boolean> => {
  const moved = await db
    .update(a2aTokenTable)
    .set({ tokenNotice: to })
    .where(
      and(
        eq(a2aTokenTable.id, token.id),
        eq(a2aTokenTable.tokenHash, token.tokenHash),
        from === null
          ? isNull(a2aTokenTable.tokenNotice)
          : eq(a2aTokenTable.tokenNotice, from),
      ),
    )
    .returning({ id: a2aTokenTable.id });
  return moved.length > 0;
};

/**
 * Claims `notice`, posts it, and hands the claim back if posting failed, so
 * the next sweep or call sends it after all. Never throws.
 */
const sendNotice = async (
  endpoint: A2aEndpointRow,
  token: A2aTokenRow,
  notice: TokenNotice,
  title: string,
  body: string,
): Promise<void> => {
  const previous = token.tokenNotice;
  try {
    if (!(await moveNotice(token, previous, notice))) return;
    const [workspace] = await db
      .select({ organizationId: workspaceTable.organizationId })
      .from(workspaceTable)
      .where(eq(workspaceTable.id, endpoint.workspaceId))
      .limit(1);
    const sent =
      !!workspace &&
      (await notifyOwner(endpoint, workspace.organizationId, title, body));
    if (!sent) await moveNotice(token, notice, previous);
  } catch (error) {
    logger.error(
      { tokenId: token.id, notice, error: errorMessage(error) },
      "Failed to send an A2A token notice",
    );
  }
};

/**
 * The first call with an expired token tells the Owner, once per token: the
 * client only sees `401`, and nothing else would say a client has stopped.
 */
const noticeExpiredUse = async (
  endpoint: A2aEndpointRow,
  token: A2aTokenRow,
): Promise<void> => {
  if (tokenNoticeSent(token.tokenNotice, "expired")) return;
  await sendNotice(
    endpoint,
    token,
    "expired",
    "A2A token has expired",
    `A call to the A2A endpoint "${endpoint.name}" used the token "${token.name}" after it expired on ${formatDate(token.tokenExpiresAt)}, and was refused. Regenerate the token on the endpoint's page and update the client that uses it.`,
  );
};

/**
 * Sends each A2A token's expiry reminders as they fall due. Run from the
 * scheduler beside the Inbound Trigger reminders; a token that fails does not
 * hold back the rest.
 */
export const sendA2aTokenReminders = async (
  now: Date = new Date(),
): Promise<void> => {
  const rows = await db
    .select()
    .from(a2aTokenTable)
    .innerJoin(
      a2aEndpointTable,
      eq(a2aEndpointTable.id, a2aTokenTable.endpointId),
    )
    .where(
      and(
        gt(a2aTokenTable.tokenExpiresAt, now),
        lte(
          a2aTokenTable.tokenExpiresAt,
          new Date(now.getTime() + 30 * DAY_MS),
        ),
      ),
    );

  for (const { a2a_token: token, a2a_endpoint: endpoint } of rows) {
    const due = dueReminder(token, now);
    if (!due || tokenNoticeSent(token.tokenNotice, due)) continue;
    await sendNotice(
      endpoint,
      token,
      due,
      "A2A token expires soon",
      `The token "${token.name}" for the A2A endpoint "${endpoint.name}" expires on ${formatDate(token.tokenExpiresAt)}. Regenerate it on the endpoint's page and update the client that uses it; calls with the current token are refused once it expires.`,
    );
  }
};
