import { and, asc, count, desc, eq, getTableColumns } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  a2aInterfaceUrl as interfaceUrl,
  gateAdmits,
  type A2aAccess,
  type A2aEndpointCreate,
  type A2aEndpointUpdate,
  type OrgGateAccessUpdate,
  type OrgGate,
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
  listOwned,
  requireOwned,
  updateOwned,
} from "./workspace-resource.ts";
import {
  generateBearerToken,
  bearerTokenStatus,
  issuedTokenFields,
  notifyTokenOwner,
} from "./bearer-token.ts";
import { getGateAccess, setGateAccess, type GateAccess } from "./org-gate.ts";
import {
  ownerMayAct,
  ownerMembershipJoin,
  ownerStandingColumns,
} from "./owner-membership.ts";
import type { A2aRejectReason } from "./a2a-call.ts";
import { stopRevokedA2aWork } from "./a2a-cancel.ts";

/**
 * A2A endpoints (ADR-0032): one Agent made reachable over A2A from one
 * Workspace, under its own unguessable URL, with one bearer token per client.
 * Only the Workspace Owner manages them, and only through the session routes —
 * no Agent tool reaches this module, so a live token never enters a model's
 * context.
 */

export type A2aEndpointRow = typeof a2aEndpointTable.$inferSelect;
type A2aTokenRow = typeof a2aTokenTable.$inferSelect;

/** Makes a leaked A2A token recognisable, beside Inbound Triggers' `pit_`. */
export const A2A_TOKEN_PREFIX = "pa2a_";

/**
 * A token as the Owner sees it listed: how it stands, never its value, hash
 * or reminder bookkeeping.
 */
export const toPublicToken = (row: A2aTokenRow) => {
  const { tokenHash: _tokenHash, tokenNotice: _tokenNotice, ...rest } = row;
  return { ...rest, tokenStatus: bearerTokenStatus(row) };
};

export const listA2aEndpoints = (workspaceId: string) =>
  listOwned(
    db,
    "a2aEndpoint",
    { workspaceId },
    asc(a2aEndpointTable.createdAt),
  );

/** The endpoint with its tokens. Throws `NotFoundError` outside the Workspace. */
export const getA2aEndpoint = async (workspaceId: string, id: string) => {
  const endpoint = await requireOwned(db, "a2aEndpoint", { id, workspaceId });
  const tokens = await db
    .select()
    .from(a2aTokenTable)
    .where(eq(a2aTokenTable.endpointId, id))
    .orderBy(asc(a2aTokenTable.createdAt));
  return { ...endpoint, tokens: tokens.map(toPublicToken) };
};

/**
 * Creates an endpoint for an Agent usable in this Workspace — its own, or an
 * attached Shared Agent. An omitted name or description is copied from the
 * Agent; the Owner edits it for outside callers later.
 */
export const createA2aEndpoint = async (
  ctx: ScopeContext,
  fields: A2aEndpointCreate,
): Promise<A2aEndpointRow> => {
  const agent = await resolveScoped(db, "agent", fields.agentId, ctx);
  if (!agent) throw new NotFoundError("Agent not found in this workspace");

  const now = new Date();
  const [row] = await db
    .insert(a2aEndpointTable)
    .values({
      // The public, unguessable part of the URL — never the Agent's id.
      id: nanoid(),
      workspaceId: ctx.workspaceId,
      agentId: fields.agentId,
      name: fields.name ?? agent.row.name,
      description: fields.description ?? agent.row.description,
      enabled: fields.enabled ?? true,
      includeMemories: fields.includeMemories ?? false,
      extractMemories: fields.extractMemories ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
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
  // Disabling it stops its running Tasks too.
  if (!row.enabled) await stopRevokedA2aWork([id]);
  return row;
};

/**
 * Deletes the endpoint; its tokens go with it by the foreign key, and its
 * running Tasks are canceled.
 */
export const deleteA2aEndpoint = async (
  workspaceId: string,
  id: string,
): Promise<void> => {
  if (!(await deleteOwned(db, "a2aEndpoint", { id, workspaceId }))) {
    throw new NotFoundError("A2A endpoint not found");
  }
  await stopRevokedA2aWork([id]);
};

/**
 * Issues a named token on the endpoint, expiring after `expiryDays`. The plaintext is in this return value
 * and nowhere else: only its hash is stored.
 */
export const createA2aToken = async (
  workspaceId: string,
  endpointId: string,
  { name, expiryDays }: { name: string; expiryDays: number },
) => {
  await requireOwned(db, "a2aEndpoint", { id: endpointId, workspaceId });
  const { token, hash } = generateBearerToken(A2A_TOKEN_PREFIX);
  const now = new Date();
  const [row] = await db
    .insert(a2aTokenTable)
    .values({
      id: nanoid(),
      endpointId,
      name,
      ...issuedTokenFields(hash, expiryDays, now),
      createdAt: now,
    })
    .returning();
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
  // Only this token's running Tasks: the endpoint's others are still live.
  await stopRevokedA2aWork([endpointId]);
};

// ------------------------------------------------------------ public side

/** A live endpoint, with what a turn needs to act as its Owner. */
export type LiveA2aEndpoint = A2aEndpointRow & {
  organizationId: string;
  ownerId: string;
};

/** Why an endpoint a public call names isn't live. */
export type A2aEndpointNotLive = Extract<
  A2aRejectReason,
  "unknown_endpoint" | "disabled" | "gate" | "owner_left"
>;

export type A2aEndpointLookup =
  | { live: true; endpoint: LiveA2aEndpoint }
  | {
      live: false;
      reason: A2aEndpointNotLive;
      /** Known unless the endpoint is unknown; for the call log. */
      organizationId?: string;
      workspaceId?: string;
    };

/**
 * The endpoint a public call names, if it is live: it exists and is enabled,
 * the Organization's A2A gate admits its Workspace, and its Workspace Owner
 * may still act (`ownerMayAct`: a member or super admin, and not banned).
 * Anything else says why, for the call log only: every public route answers
 * it with the same `404`, so a caller can't tell which endpoints exist.
 */
export const lookupA2aEndpoint = async (
  endpointId: string,
): Promise<A2aEndpointLookup> => {
  // Every call starts here, so it reads only the columns it decides on.
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
  if (!gateAdmits(row.a2aGate as OrgGate, row.a2aAllowed)) {
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
  };
};

/** The A2A protocol version, as `Major.Minor`, every card's interface serves. */
export const A2A_PROTOCOL_VERSION = "1.0";

/** The JSON-RPC interface URL an endpoint's card names. */
export const a2aInterfaceUrl = (endpointId: string) =>
  interfaceUrl(backendBaseUrl(), endpointId);

/**
 * The endpoint's one skill, built from its public name and description, so it
 * reveals nothing the card does not. A2A 1.0 §5.7: a required array holds at
 * least one element, so it has a tag and the card has the skill.
 */
const endpointSkill = (endpoint: A2aEndpointRow) => ({
  id: endpoint.id,
  name: endpoint.name,
  description: endpoint.description,
  tags: ["chat"],
});

/**
 * The public Agent Card (A2A 1.0): the endpoint's public name and description,
 * the bearer scheme, the interface URL and the endpoint's one skill. Never the
 * Agent's own description, Tool sets or Skills. Capabilities say only what
 * this server answers today.
 */
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

/**
 * The authenticated extended card: the public card. It has nothing to add, as
 * the public card already carries the endpoint's skill.
 */
export const extendedAgentCard = (endpoint: A2aEndpointRow) =>
  publicAgentCard(endpoint);

// ------------------------------------------------------------ Org Admin oversight

/**
 * Every A2A endpoint in the Organization with its tokens, for its Org Admins:
 * where it is, whose it is and which Agent it reaches. Never a token's value
 * or hash.
 */
export const listOrgA2aEndpoints = async (orgId: string) => {
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

/** The endpoint, if it is in the Organization, with its Workspace. */
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

/**
 * Tells the Workspace Owner an Org Admin revoked something of theirs. A
 * failure is logged, not thrown: the revoke has already happened.
 */
const notifyOwnerOfRevoke = async (
  orgId: string,
  endpoint: A2aEndpointRow,
  title: string,
  body: string,
): Promise<void> => {
  await notifyTokenOwner(
    { orgId, workspaceId: endpoint.workspaceId, agentId: endpoint.agentId },
    title,
    body,
  );
};

/**
 * Revokes an endpoint on an Org Admin's behalf by deleting it: its URL and
 * every token stop working at once, its running Tasks are canceled, and its
 * Chats stay. The Owner is told.
 * `false` when no endpoint by that id is in the Organization.
 */
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
  // The Owner deleted it in the meantime: nothing left to tell them about.
  if (deleted.length === 0) return false;
  await stopRevokedA2aWork([endpointId]);

  await notifyOwnerOfRevoke(
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

const TOKEN_REPLACED_MESSAGE =
  "The token was replaced since you loaded the list. Refresh it and revoke the new one if it should stop too.";

/**
 * Revokes one token on an Org Admin's behalf by deleting it, canceling its
 * running Tasks; the endpoint's other tokens keep working. The Owner is told. `false` when the token is not
 * on that endpoint, or the endpoint is not in the Organization.
 *
 * `seenTokenCreatedAt` is when the value the Admin was looking at was issued.
 * Regenerating keeps the token's id but issues a new value, which the Admin
 * never judged, so a revoke naming any other time is refused rather than
 * deleting it.
 */
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
  // A regenerate landing between the read above and this delete is refused
  // the same way, so the delete is conditional on the hash just read.
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

  await notifyOwnerOfRevoke(
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

// ------------------------------------------------------------ the gate

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

const toA2aAccess = ({ gate, workspaces }: GateAccess): A2aAccess => ({
  gate,
  workspaces: workspaces.map(({ count, ...workspace }) => ({
    ...workspace,
    a2aEndpointCount: count,
  })),
});

export const getA2aAccess = async (orgId: string): Promise<A2aAccess> =>
  toA2aAccess(await getGateAccess(A2A_GATE, orgId));

/**
 * Saves the gate and the Workspaces' switches. A Workspace it shuts out has
 * its endpoints' running Tasks canceled.
 */
export const setA2aAccess = async (
  orgId: string,
  update: OrgGateAccessUpdate,
  actorUserId: string,
): Promise<A2aAccess> => {
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
  return toA2aAccess(access);
};
