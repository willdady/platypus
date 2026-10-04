import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  a2aInterfaceUrl as interfaceUrl,
  gateAdmits,
  type A2aAccess,
  type OrgGateAccessUpdate,
  type OrgGate,
} from "@platypus/schemas";
import { db } from "../index.ts";
import {
  a2aEndpoint as a2aEndpointTable,
  a2aToken as a2aTokenTable,
  organization as organizationTable,
  organizationMember,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { NotFoundError } from "../errors.ts";
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
  fields: {
    agentId: string;
    name?: string;
    description?: string;
    enabled?: boolean;
  },
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
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
};

export const updateA2aEndpoint = async (
  workspaceId: string,
  id: string,
  fields: { name?: string; description?: string; enabled?: boolean },
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

/**
 * The endpoint a public call names, if it is live: it exists and is enabled,
 * the Organization's A2A gate admits its Workspace, and the Workspace Owner is
 * still a member of the Organization. Anything else is `null`, which every
 * public route answers with the same `404`, so a caller can't tell which
 * endpoints exist.
 */
export const loadLiveA2aEndpoint = async (
  endpointId: string,
): Promise<A2aEndpointRow | null> => {
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
  if (
    !row ||
    !row.a2a_endpoint.enabled ||
    !gateAdmits(
      row.organization.a2aGate as OrgGate,
      row.workspace.a2aAllowed,
    ) ||
    !row.organization_member
  ) {
    return null;
  }
  return row.a2a_endpoint;
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
    streaming: false,
    pushNotifications: false,
    extendedAgentCard: false,
  },
  securitySchemes: {
    bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } },
  },
  securityRequirements: [{ schemes: { bearer: { list: [] } } }],
  defaultInputModes: ["text/plain", "application/json"],
  defaultOutputModes: ["text/plain"],
  skills: [],
});

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
