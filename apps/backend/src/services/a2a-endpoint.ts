import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  sql,
} from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  a2aInterfaceUrl as interfaceUrl,
  gateAdmits,
  type OrgGateAccess,
  type A2aEndpointCreate,
  type A2aEndpointListItem,
  type A2aEndpointUpdate,
  type OrgA2aEndpoint,
  type OrgGateAccessUpdate,
} from "@platypus/schemas";
import { db } from "../index.ts";
import {
  a2aEndpoint as a2aEndpointTable,
  a2aToken as a2aTokenTable,
  agent as agentTable,
  organization as organizationTable,
  organizationMember,
  user as userTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { logger } from "../logger.ts";
import { backendBaseUrl } from "../base-urls.ts";
import type { ScopeContext } from "../scope.ts";
import { resolveScoped } from "./scoped-resource.ts";
import {
  deleteOwned,
  requireOwned,
  updateOwned,
} from "./workspace-resource.ts";
import {
  generateBearerToken,
  bearerTokenStatus,
  issuedTokenFields,
  notifyTokenOwner,
  TOKEN_REPLACED_MESSAGE,
} from "./bearer-token.ts";
import { getGateAccess, setGateAccess } from "./org-gate.ts";
import {
  ownerMayAct,
  ownerMembershipJoin,
  ownerStandingColumns,
} from "./owner-membership.ts";
import type { A2aRejectReason } from "./a2a-call.ts";
import { stopRevokedA2aWork } from "./a2a-cancel.ts";
import { oneRow } from "../db/one-row.ts";

export type A2aEndpointRow = typeof a2aEndpointTable.$inferSelect;
type A2aTokenRow = typeof a2aTokenTable.$inferSelect;

export const A2A_TOKEN_PREFIX = "pa2a_";

export const toPublicToken = (row: A2aTokenRow) => {
  const { tokenHash: _tokenHash, tokenNotice: _tokenNotice, ...rest } = row;
  return { ...rest, tokenStatus: bearerTokenStatus(row) };
};

export const listA2aEndpoints = async (
  workspaceId: string,
): Promise<A2aEndpointListItem[]> => {
  const live = db
    .select({ count: count().as("live_token_count") })
    .from(a2aTokenTable)
    .where(
      and(
        eq(a2aTokenTable.endpointId, a2aEndpointTable.id),
        gt(a2aTokenTable.tokenExpiresAt, new Date()),
      ),
    )
    .as("live_tokens");
  return db
    .select({
      ...getTableColumns(a2aEndpointTable),
      agentName: agentTable.name,
      liveTokenCount: live.count,
    })
    .from(a2aEndpointTable)
    .innerJoin(agentTable, eq(agentTable.id, a2aEndpointTable.agentId))
    .leftJoinLateral(live, sql`true`)
    .where(eq(a2aEndpointTable.workspaceId, workspaceId))
    .orderBy(asc(a2aEndpointTable.createdAt));
};

export const getA2aEndpoint = async (workspaceId: string, id: string) => {
  const endpoint = await requireOwned(db, "a2aEndpoint", { id, workspaceId });
  const tokens = await db
    .select()
    .from(a2aTokenTable)
    .where(eq(a2aTokenTable.endpointId, id))
    .orderBy(asc(a2aTokenTable.createdAt));
  return { ...endpoint, tokens: tokens.map(toPublicToken) };
};

export const createA2aEndpoint = async (
  ctx: ScopeContext,
  fields: A2aEndpointCreate,
): Promise<A2aEndpointRow> => {
  const agent = await resolveScoped(db, "agent", fields.agentId, ctx);
  if (!agent) throw new NotFoundError("Agent not found in this workspace");

  const now = new Date();
  const row = oneRow(
    await db
      .insert(a2aEndpointTable)
      .values({
        id: nanoid(),
        workspaceId: ctx.workspaceId,
        agentId: fields.agentId,
        name: fields.name ?? agent.row.name,
        description: fields.description ?? agent.row.description,
        enabled: fields.enabled,
        search: fields.search,
        includeMemories: fields.includeMemories,
        extractMemories: fields.extractMemories,
        createdAt: now,
        updatedAt: now,
      })
      .returning(),
  );
  return row;
};

export const updateA2aEndpoint = async (
  workspaceId: string,
  id: string,
  fields: A2aEndpointUpdate,
): Promise<A2aEndpointRow> => {
  const row = await updateOwned(
    db,
    "a2aEndpoint",
    { id, workspaceId },
    { ...fields, updatedAt: new Date() },
  );
  if (!row) throw new NotFoundError("A2A endpoint not found");
  if (!row.enabled) await stopRevokedA2aWork([id]);
  return row;
};

export const deleteA2aEndpoint = async (
  workspaceId: string,
  id: string,
): Promise<void> => {
  if (!(await deleteOwned(db, "a2aEndpoint", { id, workspaceId }))) {
    throw new NotFoundError("A2A endpoint not found");
  }
  await stopRevokedA2aWork([id]);
};

export const createA2aToken = async (
  workspaceId: string,
  endpointId: string,
  { name, expiryDays }: { name: string; expiryDays: number },
) => {
  await requireOwned(db, "a2aEndpoint", { id: endpointId, workspaceId });
  const { token, hash } = generateBearerToken(A2A_TOKEN_PREFIX);
  const now = new Date();
  const row = oneRow(
    await db
      .insert(a2aTokenTable)
      .values({
        id: nanoid(),
        endpointId,
        name,
        ...issuedTokenFields(hash, expiryDays, now),
        createdAt: now,
      })
      .returning(),
  );
  return { ...toPublicToken(row), token };
};

export const deleteA2aToken = async (
  workspaceId: string,
  endpointId: string,
  tokenId: string,
): Promise<void> => {
  await requireOwned(db, "a2aEndpoint", { id: endpointId, workspaceId });
  const deleted = await db
    .delete(a2aTokenTable)
    .where(
      and(
        eq(a2aTokenTable.id, tokenId),
        eq(a2aTokenTable.endpointId, endpointId),
      ),
    )
    .returning();
  if (deleted.length === 0) throw new NotFoundError("A2A token not found");
  await stopRevokedA2aWork([endpointId]);
};

export type LiveA2aEndpoint = A2aEndpointRow & {
  organizationId: string;
  ownerId: string;
};

type A2aEndpointNotLive = Extract<
  A2aRejectReason,
  "unknown_endpoint" | "disabled" | "gate" | "owner_left"
>;

export type A2aEndpointLookup = (
  | { live: true; endpoint: LiveA2aEndpoint }
  | { live: false; reason: A2aEndpointNotLive }
) & {
  organizationId?: string;
  workspaceId?: string;
};

export const lookupA2aEndpoint = async (
  endpointId: string,
): Promise<A2aEndpointLookup> => {
  const [row] = await db
    .select({
      endpoint: getTableColumns(a2aEndpointTable),
      organizationId: workspaceTable.organizationId,
      ownerId: workspaceTable.ownerId,
      a2aAllowed: workspaceTable.a2aAllowed,
      a2aGate: organizationTable.a2aGate,
      owner: ownerStandingColumns,
    })
    .from(a2aEndpointTable)
    .innerJoin(
      workspaceTable,
      eq(workspaceTable.id, a2aEndpointTable.workspaceId),
    )
    .innerJoin(
      organizationTable,
      eq(organizationTable.id, workspaceTable.organizationId),
    )
    .innerJoin(userTable, eq(userTable.id, workspaceTable.ownerId))
    .leftJoin(organizationMember, ownerMembershipJoin())
    .where(eq(a2aEndpointTable.id, endpointId))
    .limit(1);
  if (!row) return { live: false, reason: "unknown_endpoint" };
  const notLive = (reason: A2aEndpointNotLive): A2aEndpointLookup => ({
    live: false,
    reason,
    organizationId: row.organizationId,
    workspaceId: row.endpoint.workspaceId,
  });
  if (!row.endpoint.enabled) return notLive("disabled");
  if (!gateAdmits(row.a2aGate, row.a2aAllowed)) {
    return notLive("gate");
  }
  if (!ownerMayAct(row.owner)) return notLive("owner_left");
  return {
    live: true,
    endpoint: {
      ...row.endpoint,
      organizationId: row.organizationId,
      ownerId: row.ownerId,
    },
    organizationId: row.organizationId,
    workspaceId: row.endpoint.workspaceId,
  };
};

export const A2A_PROTOCOL_VERSION = "1.0";

export const a2aInterfaceUrl = (endpointId: string) =>
  interfaceUrl(backendBaseUrl(), endpointId);

const endpointSkill = (endpoint: A2aEndpointRow) => ({
  id: endpoint.id,
  name: endpoint.name,
  description: endpoint.description,
  tags: ["chat"],
});

export const publicAgentCard = (endpoint: A2aEndpointRow) => ({
  name: endpoint.name,
  description: endpoint.description,
  supportedInterfaces: [
    {
      url: a2aInterfaceUrl(endpoint.id),
      protocolBinding: "JSONRPC",
      protocolVersion: A2A_PROTOCOL_VERSION,
    },
  ],
  version: "1.0.0",
  capabilities: {
    streaming: true,
    pushNotifications: true,
    extendedAgentCard: true,
  },
  securitySchemes: {
    bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } },
  },
  securityRequirements: [{ schemes: { bearer: { list: [] } } }],
  defaultInputModes: ["text/plain", "application/json"],
  defaultOutputModes: ["text/plain"],
  skills: [endpointSkill(endpoint)],
});

export const listOrgA2aEndpoints = async (
  orgId: string,
): Promise<OrgA2aEndpoint[]> => {
  const inOrg = eq(workspaceTable.organizationId, orgId);
  const [endpoints, tokens] = await Promise.all([
    db
      .select({
        id: a2aEndpointTable.id,
        name: a2aEndpointTable.name,
        enabled: a2aEndpointTable.enabled,
        agentId: agentTable.id,
        agentName: agentTable.name,
        workspaceId: workspaceTable.id,
        workspaceName: workspaceTable.name,
        ownerId: userTable.id,
        ownerName: userTable.name,
        createdAt: a2aEndpointTable.createdAt,
      })
      .from(a2aEndpointTable)
      .innerJoin(
        workspaceTable,
        eq(workspaceTable.id, a2aEndpointTable.workspaceId),
      )
      .innerJoin(userTable, eq(userTable.id, workspaceTable.ownerId))
      .innerJoin(agentTable, eq(agentTable.id, a2aEndpointTable.agentId))
      .where(inOrg)
      .orderBy(desc(a2aEndpointTable.createdAt)),
    db
      .select(getTableColumns(a2aTokenTable))
      .from(a2aTokenTable)
      .innerJoin(
        a2aEndpointTable,
        eq(a2aEndpointTable.id, a2aTokenTable.endpointId),
      )
      .innerJoin(
        workspaceTable,
        eq(workspaceTable.id, a2aEndpointTable.workspaceId),
      )
      .where(inOrg)
      .orderBy(asc(a2aTokenTable.createdAt)),
  ]);
  const byEndpoint = new Map<string, ReturnType<typeof toPublicToken>[]>();
  for (const token of tokens) {
    const listed = byEndpoint.get(token.endpointId) ?? [];
    listed.push(toPublicToken(token));
    byEndpoint.set(token.endpointId, listed);
  }
  return endpoints.map((endpoint) => ({
    ...endpoint,
    tokens: byEndpoint.get(endpoint.id) ?? [],
  }));
};

const findOrgEndpoint = async (orgId: string, endpointId: string) => {
  const [row] = await db
    .select()
    .from(a2aEndpointTable)
    .innerJoin(
      workspaceTable,
      eq(workspaceTable.id, a2aEndpointTable.workspaceId),
    )
    .where(
      and(
        eq(a2aEndpointTable.id, endpointId),
        eq(workspaceTable.organizationId, orgId),
      ),
    )
    .limit(1);
  return row?.a2a_endpoint ?? null;
};

export const revokeOrgA2aEndpoint = async (
  orgId: string,
  endpointId: string,
): Promise<boolean> => {
  const endpoint = await findOrgEndpoint(orgId, endpointId);
  if (!endpoint) return false;
  const deleted = await db
    .delete(a2aEndpointTable)
    .where(eq(a2aEndpointTable.id, endpointId))
    .returning({ id: a2aEndpointTable.id });
  if (deleted.length === 0) return false;
  await stopRevokedA2aWork([endpointId]);

  await notifyTokenOwner(
    orgId,
    endpoint,
    "A2A endpoint revoked",
    `An Organization Admin revoked the A2A endpoint "${endpoint.name}", so its URL and every one of its tokens are refused. Its Chats are kept. If clients should reach this agent again, create a new endpoint and give them its URL and new tokens.`,
  );
  logger.info(
    { endpointId, organizationId: orgId, workspaceId: endpoint.workspaceId },
    "A2A endpoint revoked by an Org Admin",
  );
  return true;
};

export const revokeOrgA2aToken = async (
  orgId: string,
  endpointId: string,
  tokenId: string,
  seenTokenCreatedAt: Date,
): Promise<boolean> => {
  const endpoint = await findOrgEndpoint(orgId, endpointId);
  if (!endpoint) return false;
  const [token] = await db
    .select()
    .from(a2aTokenTable)
    .where(
      and(
        eq(a2aTokenTable.id, tokenId),
        eq(a2aTokenTable.endpointId, endpointId),
      ),
    )
    .limit(1);
  if (!token) return false;
  if (token.tokenCreatedAt.getTime() !== seenTokenCreatedAt.getTime()) {
    throw new ConflictError(TOKEN_REPLACED_MESSAGE);
  }
  // why: on the hash just read, so a regenerate since is refused, not revoked unseen
  const deleted = await db
    .delete(a2aTokenTable)
    .where(
      and(
        eq(a2aTokenTable.id, tokenId),
        eq(a2aTokenTable.tokenHash, token.tokenHash),
      ),
    )
    .returning({ id: a2aTokenTable.id });
  if (deleted.length === 0) throw new ConflictError(TOKEN_REPLACED_MESSAGE);
  await stopRevokedA2aWork([endpointId]);

  await notifyTokenOwner(
    orgId,
    endpoint,
    "A2A token revoked",
    `An Organization Admin revoked the token "${token.name}" on the A2A endpoint "${endpoint.name}", so calls with it are refused. If that client should keep working, issue it a new token on the endpoint's page.`,
  );
  logger.info(
    {
      endpointId,
      tokenId,
      organizationId: orgId,
      workspaceId: endpoint.workspaceId,
    },
    "A2A token revoked by an Org Admin",
  );
  return true;
};

const A2A_GATE = {
  gate: "a2aGate",
  allowed: "a2aAllowed",
  resourceCounts: (orgId: string) =>
    db
      .select({ workspaceId: a2aEndpointTable.workspaceId, count: count() })
      .from(a2aEndpointTable)
      .innerJoin(
        workspaceTable,
        eq(workspaceTable.id, a2aEndpointTable.workspaceId),
      )
      .where(eq(workspaceTable.organizationId, orgId))
      .groupBy(a2aEndpointTable.workspaceId),
  changedMessage: "A2A access changed by an Org Admin",
} as const;

export const getA2aAccess = (orgId: string): Promise<OrgGateAccess> =>
  getGateAccess(A2A_GATE, orgId);

export const setA2aAccess = async (
  orgId: string,
  update: OrgGateAccessUpdate,
  actorUserId: string,
): Promise<OrgGateAccess> => {
  const access = await setGateAccess(A2A_GATE, orgId, update, actorUserId);
  const endpoints = await db
    .select({ id: a2aEndpointTable.id })
    .from(a2aEndpointTable)
    .innerJoin(
      workspaceTable,
      eq(workspaceTable.id, a2aEndpointTable.workspaceId),
    )
    .where(eq(workspaceTable.organizationId, orgId));
  await stopRevokedA2aWork(endpoints.map((endpoint) => endpoint.id));
  return access;
};
