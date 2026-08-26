import type { z } from "zod";
import type { SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { mcp as mcpTable } from "../db/schema.ts";
import { mcpCreateSchema, mcpUpdateSchema } from "@platypus/schemas";
import type { ScopeContext } from "../scope.ts";
import { NotFoundError } from "../errors.ts";
import { scrubDeletedAgentReference } from "./agent-references.ts";
import { OAUTH_TOKEN_CLEAR_FIELDS } from "./mcp-connection.ts";
import { assertMcpSlugAvailable, deriveMcpSlug } from "./mcp-namespace.ts";
import {
  orgScopedWhere,
  requireOrgScoped,
  requireSharedDeletable,
  requireWorkspaceMutable,
  workspaceScopedWhere,
} from "./scoped-resource.ts";

/**
 * The MCP write model: create/update/delete that both route surfaces adapt
 * over — `routes/mcp.ts` (Workspace surface) and `routes/org-mcp.ts`
 * (Organization surface). They used to each carry a verbatim copy of the
 * OAuth-clear-on-URL-change logic and had already drifted (#689): the
 * Workspace surface's delete never scrubbed a deleted MCP's id from
 * referencing Agents' `toolSetIds`, unlike the Organization surface, which
 * already did. Both scopes now scrub identically.
 *
 * Mirrors `services/provider-write.ts` and `services/skill.ts`: a standalone
 * module, not a generalized Scoped-resource write model — `McpScope` is its
 * own independently-declared type, the same shape as `ProviderScope`/
 * `SkillScope` but not unified with them.
 */

export type McpRow = typeof mcpTable.$inferSelect;

/** The fields a create carries — every field but the id and its scope. */
export type McpCreateFields = Omit<
  z.infer<typeof mcpCreateSchema>,
  "organizationId" | "workspaceId"
>;

/** The fields an update carries — mcpUpdateSchema replaces the form wholesale. */
export type McpUpdateFields = z.infer<typeof mcpUpdateSchema>;

/**
 * Which scope a write targets — the Workspace surface (ADR-0006 delegation
 * applies, a Shared row is locked) or the Organization surface (admin-only,
 * writes a Shared row directly). Mirrors `ProviderScope`/`SkillScope`.
 */
export type McpScope =
  | { kind: "workspace"; ctx: ScopeContext }
  | { kind: "organization"; orgId: string };

/**
 * Creates a new MCP at the given scope. The scope comes from `scope`, never
 * the body — a caller cannot name another Workspace, or mint a Shared MCP
 * from the Workspace surface, by setting `organizationId`/`workspaceId` in
 * the request (ADR-0006, ADR-0007): those fields are spread from `fields`
 * first, then overridden by the scope-derived values below. A duplicate slug
 * throws `ConflictError` from `assertMcpSlugAvailable`; a duplicate name
 * surfaces as a Postgres unique violation, mapped to 409 by the central
 * `onError` (ADR-0010).
 */
export async function createMcp(
  scope: McpScope,
  fields: McpCreateFields,
): Promise<McpRow> {
  const orgId = scope.kind === "workspace" ? scope.ctx.orgId : scope.orgId;
  const slug = deriveMcpSlug(fields.name);
  await assertMcpSlugAvailable(slug, { orgId });

  const [row] = await db
    .insert(mcpTable)
    .values({
      id: nanoid(),
      ...fields,
      slug,
      ...(scope.kind === "workspace"
        ? { workspaceId: scope.ctx.workspaceId, organizationId: null }
        : { organizationId: scope.orgId, workspaceId: null }),
    })
    .returning();
  return row;
}

/**
 * Updates an MCP at the given scope. Throws `NotFoundError` when the MCP is
 * not visible at this scope, and (Workspace scope only) `LockedError` when it
 * is a Shared MCP edited only on the Organization surface (ADR-0007). If the
 * `url` is changing, the stored OAuth tokens are cleared — they are
 * server-specific and would otherwise be sent to whatever server now sits at
 * the new URL — while the DCR/static `oauthClientId`/`oauthClientSecret` are
 * also cleared, matching what both routes did inline before this module
 * existed.
 */
export async function updateMcp(
  scope: McpScope,
  mcpId: string,
  fields: McpUpdateFields,
): Promise<McpRow> {
  let where: SQL;
  let existingUrl: string | null;
  let orgId: string;

  if (scope.kind === "workspace") {
    // A Shared MCP is a single source of truth edited only on the
    // Organization surface (ADR-0007); requireWorkspaceMutable throws
    // NotFound (→404) when the MCP is not visible here, then Locked (→403)
    // when it is org-scoped.
    const { row } = await requireWorkspaceMutable(db, "mcp", mcpId, scope.ctx);
    where = workspaceScopedWhere("mcp", mcpId, scope.ctx.workspaceId);
    existingUrl = row.url;
    orgId = scope.ctx.orgId;
  } else {
    // requireOrgScoped throws NotFound (→404) before the write ever runs,
    // rather than deferring to an empty UPDATE result.
    const row = await requireOrgScoped(db, "mcp", mcpId, scope.orgId);
    where = orgScopedWhere("mcp", mcpId, scope.orgId);
    existingUrl = row.url;
    orgId = scope.orgId;
  }

  const urlChanged = existingUrl !== fields.url;

  const slug = deriveMcpSlug(fields.name);
  await assertMcpSlugAvailable(slug, { orgId }, mcpId);

  // A duplicate name surfaces as a Postgres unique violation, mapped to 409
  // by the central onError (ADR-0010).
  const [row] = await db
    .update(mcpTable)
    .set({
      ...fields,
      slug,
      ...(urlChanged && {
        ...OAUTH_TOKEN_CLEAR_FIELDS,
        oauthClientId: null,
        oauthClientSecret: null,
      }),
      updatedAt: new Date(),
    })
    .where(where)
    .returning();

  // The pre-checks above prove the row exists, but a concurrent delete can
  // still win the race between the check and the UPDATE. Checked at both
  // scopes here — unlike `updateProvider` (neither scope) and `updateSkill`
  // (organization scope only) — since nothing about the race is
  // scope-specific; this is a small tightening over those two, not a
  // deliberate divergence.
  if (!row) {
    throw new NotFoundError("MCP not found");
  }
  return row;
}

/**
 * Deletes an MCP at the given scope. Throws `NotFoundError` (Workspace scope,
 * via `requireWorkspaceMutable`; Organization scope, when the delete matches
 * no row) and, Workspace scope only, `LockedError` for a Shared MCP
 * (ADR-0007). Organization scope also throws `ConflictError` while an
 * Attachment or Blueprint still references the MCP (ADR-0007/0008).
 *
 * Scrubs the deleted MCP's (now-dead) id from any referencing Agent's
 * `toolSetIds`, in the same transaction as the delete, at **both** scopes
 * (#689) — a dangling reference would otherwise persist forever (ADR-0007's
 * deletion-never-leaves-dangling-references guarantee). Deliberately does
 * *not* block the Workspace-scope delete behind a referencing-Agent check the
 * way `deleteSkill` does: that asymmetry has no documented rationale, and MCP
 * has never returned 409 for this reason at either scope — scrubbing both
 * scopes identically is the fix, not importing Skill's inconsistency.
 */
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

  // A Shared resource cannot be deleted while anything still points at it —
  // an Attachment (ADR-0007) or a Blueprint (ADR-0008). Throws ConflictError
  // → 409 via the central onError (ADR-0010).
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
