import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import { a2aToken as a2aTokenTable } from "../db/schema.ts";
import { lookupA2aEndpoint } from "./a2a-endpoint.ts";
import type { A2aCaller } from "./a2a-task.ts";
import type { TaskRow } from "./a2a-task-state.ts";

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

export const callerIsLive = (caller: A2aCaller): Promise<boolean> =>
  credentialLive(
    caller.endpoint.id,
    caller.token.id,
    caller.token.tokenCreatedAt,
  );

export const taskIsLive = async (
  task: Pick<TaskRow, "endpointId" | "tokenId" | "createdAt">,
): Promise<boolean> =>
  !!task.endpointId &&
  !!task.tokenId &&
  credentialLive(task.endpointId, task.tokenId, task.createdAt);
