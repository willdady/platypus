import { and, asc, desc, eq } from "drizzle-orm";
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
import { errorMessage } from "../utils/error-message.ts";
import { createNotification } from "./notification.ts";
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
  inboundTokenStatus,
  issuedTokenFields,
} from "./inbound-trigger-token.ts";
import { getGateAccess, setGateAccess, type GateAccess } from "./org-gate.ts";
import { ownerMembershipJoin } from "./owner-membership.ts";
import type { A2aRejectReason } from "./a2a-call.ts";

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
  return { ...rest, tokenStatus: inboundTokenStatus(row) };
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
  return row;
};

/** Deletes the endpoint; its tokens go with it by the foreign key. */
export const deleteA2aEndpoint = async (
  workspaceId: string,
  id: string,
): Promise<void> => {
  if (!(await deleteOwned(db, "a2aEndpoint", { id, workspaceId }))) {
    throw new NotFoundError("A2A endpoint not found");
  }
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
 * the Organization's A2A gate admits its Workspace, and the Workspace Owner is
 * still a member of the Organization. Anything else says why, for the call
 * log only: every public route answers it with the same `404`, so a caller
 * can't tell which endpoints exist.
 */
export const lookupA2aEndpoint = async (
  endpointId: string,
): Promise<A2aEndpointLookup> => {
  const [row] = await db
    .select()
    .from(a2aEndpointTable)
    .innerJoin(
      workspaceTable,
      eq(workspaceTable.id, a2aEndpointTable.workspaceId),
    )
    .innerJoin(
      organizationTable,
      eq(organizationTable.id, workspaceTable.organizationId),
    )
    .leftJoin(organizationMember, ownerMembershipJoin())
    .where(eq(a2aEndpointTable.id, endpointId))
    .limit(1);
  if (!row) return { live: false, reason: "unknown_endpoint" };
  const notLive = (reason: A2aEndpointNotLive): A2aEndpointLookup => ({
    live: false,
    reason,
    organizationId: row.workspace.organizationId,
    workspaceId: row.workspace.id,
  });
  if (!row.a2a_endpoint.enabled) return notLive("disabled");
  if (
    !gateAdmits(row.organization.a2aGate as OrgGate, row.workspace.a2aAllowed)
  ) {
    return notLive("gate");
  }
  if (!row.organization_member) return notLive("owner_left");
  return {
    live: true,
    endpoint: {
      ...row.a2a_endpoint,
      organizationId: row.workspace.organizationId,
      ownerId: row.workspace.ownerId,
    },
  };
};

/** The JSON-RPC interface URL an endpoint's card names. */
export const a2aInterfaceUrl = (endpointId: string) =>
  interfaceUrl(backendBaseUrl(), endpointId);

/**
 * The public Agent Card (A2A 1.0): the endpoint's public name and description,
 * the bearer scheme and the interface URL. Never the Agent's own description,
 * Tool sets or Skills. Capabilities say only what this server answers today.
 */
export const publicAgentCard = (endpoint: A2aEndpointRow) => ({
  name: endpoint.name,
  description: endpoint.description,
  supportedInterfaces: [
    {
      url: a2aInterfaceUrl(endpoint.id),
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
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
  skills: [],
});

/**
 * The authenticated extended card: the public card plus one skill, built from
 * the same public name and description.
 */
export const extendedAgentCard = (endpoint: A2aEndpointRow) => ({
  ...publicAgentCard(endpoint),
  skills: [
    {
      id: endpoint.id,
      name: endpoint.name,
      description: endpoint.description,
      tags: [],
      examples: [],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    },
  ],
});

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
      .select()
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
      .where(inOrg)
      .orderBy(asc(a2aTokenTable.createdAt)),
  ]);
  return endpoints.map(
    ({ a2a_endpoint: endpoint, workspace, user, agent }) => ({
      id: endpoint.id,
      name: endpoint.name,
      enabled: endpoint.enabled,
      agentId: agent.id,
      agentName: agent.name,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      ownerId: user.id,
      ownerName: user.name,
      createdAt: endpoint.createdAt,
      tokens: tokens
        .filter((row) => row.a2a_token.endpointId === endpoint.id)
        .map((row) => toPublicToken(row.a2a_token)),
    }),
  );
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
) => {
  try {
    await createNotification(
      db,
      {
        orgId,
        workspaceId: endpoint.workspaceId,
        agentId: endpoint.agentId,
      },
      { title, body },
    );
  } catch (error) {
    logger.error(
      { endpointId: endpoint.id, error: errorMessage(error) },
      "Failed to notify the Workspace Owner about an A2A revoke",
    );
  }
};

/**
 * Revokes an endpoint on an Org Admin's behalf by deleting it: its URL and
 * every token stop working at once, and its Chats stay. The Owner is told.
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
 * Revokes one token on an Org Admin's behalf by deleting it; the endpoint's
 * other tokens keep working. The Owner is told. `false` when the token is not
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
  resourceWorkspaceIds: async (orgId: string) =>
    (
      await db
        .select({ workspaceId: a2aEndpointTable.workspaceId })
        .from(a2aEndpointTable)
        .innerJoin(
          workspaceTable,
          eq(workspaceTable.id, a2aEndpointTable.workspaceId),
        )
        .where(eq(workspaceTable.organizationId, orgId))
    ).map((row) => row.workspaceId),
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

export const setA2aAccess = async (
  orgId: string,
  update: OrgGateAccessUpdate,
  actorUserId: string,
): Promise<A2aAccess> =>
  toA2aAccess(await setGateAccess(A2A_GATE, orgId, update, actorUserId));
