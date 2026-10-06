import { and, eq, getTableColumns, gt, lte, sql } from "drizzle-orm";
import { db } from "../index.ts";
import {
  a2aEndpoint as a2aEndpointTable,
  a2aToken as a2aTokenTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { NotFoundError } from "../errors.ts";
import {
  A2A_TOKEN_PREFIX,
  lookupA2aEndpoint,
  toPublicToken,
  type A2aEndpointLookup,
  type LiveA2aEndpoint,
} from "./a2a-endpoint.ts";
import { stopRevokedA2aWork } from "./a2a-cancel.ts";
import {
  bearerToken,
  DAY_MS,
  dueReminder,
  generateBearerToken,
  hashBearerToken,
  noticeDate,
  sendTokenNotice,
  tokenNoticeSent,
  touchToken,
  tokenOwner,
} from "./bearer-token.ts";

/**
 * An A2A token's lifecycle (ADR-0032), which follows an Inbound Trigger's
 * (ADR-0030): it expires, the Owner is reminded 30 and 7 days before and told
 * the first time it is used after, and last used and last rejected are written
 * at most once a minute. Each Notification is claimed on the token row before
 * it is sent, so a peer never repeats one and deleting it never brings it back.
 */

export type A2aTokenRow = typeof a2aTokenTable.$inferSelect;

type A2aAuthResult =
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
  // Matched by hash, as every token is; see `hashBearerToken`.
  const [token] = await db
    .select()
    .from(a2aTokenTable)
    .where(
      and(
        eq(a2aTokenTable.endpointId, endpointId),
        eq(a2aTokenTable.tokenHash, hashBearerToken(presented)),
      ),
    )
    .limit(1);
  if (!token) return { ok: false, status: 401, reason: "bad_token", endpoint };

  if (token.tokenExpiresAt <= now) {
    void touchA2aToken(token.id, "lastRejectedAt", now);
    await noticeExpiredUse(endpoint, token);
    return {
      ok: false,
      status: 401,
      reason: "expired_token",
      endpoint,
      tokenId: token.id,
    };
  }
  // Off the response path: a stamp's failure is logged, never the caller's.
  void touchA2aToken(token.id, "lastUsedAt", now);
  return { ok: true, endpoint, token };
};

// ----------------------------------------------------------------- regenerate

/**
 * Issues a new value for the token, with the lifetime it was issued with. The
 * old value stops working at once, as do the Tasks it started, and the
 * reminder record is cleared. The new value is in this return value and
 * nowhere else.
 */
export const regenerateA2aToken = async (
  workspaceId: string,
  endpointId: string,
  tokenId: string,
) => {
  const now = new Date();
  const { token, hash } = generateBearerToken(A2A_TOKEN_PREFIX);
  // One write: the endpoint's Workspace is checked in the WHERE, and the
  // lifetime is read off the row being replaced.
  const [row] = await db
    .update(a2aTokenTable)
    .set({
      tokenHash: hash,
      tokenCreatedAt: now,
      tokenExpiresAt: sql`${now.toISOString()}::timestamp + (${a2aTokenTable.tokenExpiresAt} - ${a2aTokenTable.tokenCreatedAt})`,
      tokenNotice: null,
    })
    .from(a2aEndpointTable)
    .where(
      and(
        eq(a2aTokenTable.id, tokenId),
        eq(a2aTokenTable.endpointId, endpointId),
        eq(a2aEndpointTable.id, a2aTokenTable.endpointId),
        eq(a2aEndpointTable.workspaceId, workspaceId),
      ),
    )
    .returning(getTableColumns(a2aTokenTable));
  if (!row) throw new NotFoundError("A2A token not found");
  await stopRevokedA2aWork([endpointId]);
  return { ...toPublicToken(row), token };
};

// ----------------------------------------------------------------- last used

/** Stamps last used or last rejected; see {@link touchToken}. */
export const touchA2aToken = (
  tokenId: string,
  column: "lastUsedAt" | "lastRejectedAt",
  now: Date = new Date(),
): Promise<void> => touchToken(a2aTokenTable, tokenId, column, now);

// ----------------------------------------------------------------- notices

/**
 * The first call with an expired token tells the Owner, once per token: the
 * client only sees `401`, and nothing else would say a client has stopped.
 */
const noticeExpiredUse = async (
  endpoint: LiveA2aEndpoint,
  token: A2aTokenRow,
): Promise<void> => {
  if (tokenNoticeSent(token.tokenNotice, "expired")) return;
  await sendTokenNotice(
    a2aTokenTable,
    token,
    "expired",
    tokenOwner(endpoint.organizationId, endpoint),
    "A2A token has expired",
    `A call to the A2A endpoint "${endpoint.name}" used the token "${token.name}" after it expired on ${noticeDate(token.tokenExpiresAt)}, and was refused. Regenerate the token on the endpoint's page and update the client that uses it.`,
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
    .innerJoin(
      workspaceTable,
      eq(workspaceTable.id, a2aEndpointTable.workspaceId),
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

  for (const { a2a_token: token, a2a_endpoint: endpoint, workspace } of rows) {
    const due = dueReminder(token, now);
    if (!due || tokenNoticeSent(token.tokenNotice, due)) continue;
    await sendTokenNotice(
      a2aTokenTable,
      token,
      due,
      tokenOwner(workspace.organizationId, endpoint),
      "A2A token expires soon",
      `The token "${token.name}" for the A2A endpoint "${endpoint.name}" expires on ${noticeDate(token.tokenExpiresAt)}. Regenerate it on the endpoint's page and update the client that uses it; calls with the current token are refused once it expires.`,
    );
  }
};
