import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { mcp as mcpTable } from "../db/schema.ts";
import type { mcpCreateSchema, mcpUpdateSchema } from "@platypus/schemas";
import type { ScopeContext } from "../scope.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { MCP_URL_BLOCKED_MESSAGE, mcpUrlPermitted } from "./mcp-client.ts";
import { scrubDeletedAgentReference } from "./agent-references.ts";
import {
  OAUTH_CLIENT_CLEAR_FIELDS,
  OAUTH_TOKEN_CLEAR_FIELDS,
} from "./mcp-oauth-provider.ts";
import { assertMcpSlugAvailable, deriveMcpSlug } from "./mcp-namespace.ts";
import {
  orgScopedWhere,
  requireOrgScoped,
  requireSharedDeletable,
  requireWorkspaceMutable,
  workspaceScopedWhere,
} from "./scoped-resource.ts";
import { oneRow } from "../db/one-row.ts";

export type McpRow = typeof mcpTable.$inferSelect;

export type McpCreateFields = z.infer<typeof mcpCreateSchema>;

export type McpUpdateFields = z.infer<typeof mcpUpdateSchema>;

export type McpScope =
  | { kind: "workspace"; ctx: ScopeContext }
  | { kind: "organization"; orgId: string };

const assertMcpUrlPermitted = async (
  url: string | null | undefined,
  mcpId?: string,
) => {
  if (url && !(await mcpUrlPermitted(url, mcpId))) {
    throw new ValidationError(MCP_URL_BLOCKED_MESSAGE);
  }
};

export async function createMcp(
  scope: McpScope,
  fields: McpCreateFields,
): Promise<McpRow> {
  await assertMcpUrlPermitted(fields.url);
  const orgId = scope.kind === "workspace" ? scope.ctx.orgId : scope.orgId;
  const slug = deriveMcpSlug(fields.name);
  await assertMcpSlugAvailable(slug, { orgId });

  const row = oneRow(
    await db
      .insert(mcpTable)
      .values({
        id: nanoid(),
        ...fields,
        slug,
        ...(scope.kind === "workspace"
          ? { workspaceId: scope.ctx.workspaceId, organizationId: null }
          : { organizationId: scope.orgId, workspaceId: null }),
      })
      .returning(),
  );
  return row;
}

const CONNECTION_FIELDS = [
  "url",
  "headers",
  "authType",
  "bearerToken",
  "oauthClientId",
  "oauthClientSecret",
  "oauthRequestedScope",
] as const satisfies ReadonlyArray<keyof McpUpdateFields & keyof McpRow>;

const oauthResetPatch = (existing: McpRow, fields: McpUpdateFields) => {
  if (existing.url !== fields.url) {
    return {
      ...OAUTH_TOKEN_CLEAR_FIELDS,
      ...OAUTH_CLIENT_CLEAR_FIELDS,
      ...(fields.oauthClientId !== undefined && {
        oauthClientId: fields.oauthClientId,
      }),
      ...(fields.oauthClientSecret !== undefined && {
        oauthClientSecret: fields.oauthClientSecret,
      }),
    };
  }
  const clientIdChanged =
    fields.oauthClientId !== undefined &&
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- treats an empty client id the same as none
    (fields.oauthClientId || null) !== (existing.oauthClientId || null);
  if (!clientIdChanged) return {};
  return {
    ...OAUTH_TOKEN_CLEAR_FIELDS,
    oauthClientDynamicallyRegistered: false,
    ...(fields.oauthClientSecret === undefined && { oauthClientSecret: null }),
  };
};

export async function updateMcp(
  scope: McpScope,
  mcpId: string,
  fields: McpUpdateFields,
): Promise<McpRow> {
  let where: SQL;
  let existing: McpRow;
  let orgId: string;

  if (scope.kind === "workspace") {
    const { row } = await requireWorkspaceMutable(db, "mcp", mcpId, scope.ctx);
    where = workspaceScopedWhere("mcp", mcpId, scope.ctx.workspaceId);
    existing = row;
    orgId = scope.ctx.orgId;
  } else {
    const row = await requireOrgScoped(db, "mcp", mcpId, scope.orgId);
    where = orgScopedWhere("mcp", mcpId, scope.orgId);
    existing = row;
    orgId = scope.orgId;
  }

  const connectionChanged = CONNECTION_FIELDS.some(
    (field) =>
      fields[field] !== undefined &&
      !isDeepStrictEqual(fields[field] ?? null, existing[field] ?? null),
  );

  if (fields.url !== existing.url) {
    await assertMcpUrlPermitted(fields.url, mcpId);
  }
  const slug = deriveMcpSlug(fields.name);
  await assertMcpSlugAvailable(slug, { orgId }, mcpId);

  const [row] = await db
    .update(mcpTable)
    .set({
      ...fields,
      slug,
      ...oauthResetPatch(existing, fields),
      ...(connectionChanged && {
        lastKnownToolListing: null,
        lastKnownToolListingFetchedAt: null,
        lastFetchFailedAt: null,
      }),
      updatedAt: new Date(),
    })
    .where(where)
    .returning();

  if (!row) {
    throw new NotFoundError("MCP not found");
  }
  return row;
}

export async function deleteMcp(scope: McpScope, mcpId: string): Promise<void> {
  if (scope.kind === "workspace") {
    await requireWorkspaceMutable(db, "mcp", mcpId, scope.ctx);
    const where = workspaceScopedWhere("mcp", mcpId, scope.ctx.workspaceId);

    await db.transaction(async (tx) => {
      const rows = await tx.delete(mcpTable).where(where).returning();
      if (rows.length > 0) {
        await scrubDeletedAgentReference(tx, "toolSetIds", mcpId);
      }
    });
    return;
  }

  await requireSharedDeletable(db, "mcp", mcpId);

  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(mcpTable)
      .where(orgScopedWhere("mcp", mcpId, scope.orgId))
      .returning();
    if (rows.length > 0) {
      await scrubDeletedAgentReference(tx, "toolSetIds", mcpId);
    }
    return rows;
  });
  if (result.length === 0) {
    throw new NotFoundError("MCP not found");
  }
}
