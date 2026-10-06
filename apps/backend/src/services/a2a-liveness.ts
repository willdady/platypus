import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import { a2aToken as a2aTokenTable } from "../db/schema.ts";
import { lookupA2aEndpoint } from "./a2a-endpoint.ts";
import type { A2aCaller } from "./a2a-task.ts";
import type { TaskRow } from "./a2a-task-state.ts";

/**
 * Whether A2A work already under way may go on (ADR-0032). Cutting off access
 * — deleting or regenerating a token, disabling, deleting or revoking an
 * endpoint, closing the Org gate, or the Owner leaving or being banned —
 * refuses new calls at once; this is what work already started is held to,
 * so it stops too.
 */

/**
 * Whether the endpoint is live and still holds the token, with a value issued
 * no later than `issuedBy`. A token regenerated since was issued after, so
 * work done with its old value stops with that value.
 */
const credentialLive = async (
  endpointId: string,
  tokenId: string,
  issuedBy: Date,
): Promise<boolean> => {
  const lookup = await lookupA2aEndpoint(endpointId);
  if (!lookup.live) return false;
  const [token] = await db
    .select({ tokenCreatedAt: a2aTokenTable.tokenCreatedAt })
    .from(a2aTokenTable)
    .where(
      and(
        eq(a2aTokenTable.id, tokenId),
        eq(a2aTokenTable.endpointId, endpointId),
      ),
    )
    .limit(1);
  return !!token && token.tokenCreatedAt.getTime() <= issuedBy.getTime();
};

/** Whether the call's endpoint and the token value it carried are still live. */
export const callerIsLive = (caller: A2aCaller): Promise<boolean> =>
  credentialLive(
    caller.endpoint.id,
    caller.token.id,
    caller.token.tokenCreatedAt,
  );

/**
 * Whether the endpoint and token that started the Task are still live. A Task
 * whose token or endpoint was deleted has neither.
 */
export const taskIsLive = async (
  task: Pick<TaskRow, "endpointId" | "tokenId" | "createdAt">,
): Promise<boolean> =>
  !!task.endpointId &&
  !!task.tokenId &&
  credentialLive(task.endpointId, task.tokenId, task.createdAt);
