import { and, eq, ne, or } from "drizzle-orm";
import { slugifyMcpName } from "@platypus/schemas";
import { db } from "../index.ts";
import { mcp as mcpTable, workspace as workspaceTable } from "../db/schema.ts";
import { ConflictError } from "../errors.ts";

/**
 * Derive an MCP's tool-namespace slug from its display `name` (issue #467).
 * Re-exported from here (rather than every caller importing the schemas
 * package directly) so the one module that owns MCP-slug conflict checking
 * also owns deriving the value it checks.
 */
export const deriveMcpSlug = slugifyMcpName;

/**
 * Reject a slug that collides with another MCP reachable from the same
 * Organization (issue #467) — every MCP an org-scoped MCP's Workspaces could
 * attach it alongside, and vice versa. Same-scope collisions are already
 * caught by the database's `unique_mcp_slug_org` / `unique_mcp_slug_workspace`
 * constraints; this is the layer those cannot be, because an org-scoped and a
 * Workspace-scoped row differ in which scope column is set:
 *
 * - An **org-scoped** MCP is attachable from every Workspace in that
 *   Organization, so it must not share a slug with any Workspace-scoped MCP
 *   in any of those Workspaces.
 * - A **workspace-scoped** MCP must not share a slug with an org-scoped MCP
 *   Shared into its Organization (visible in every Workspace there,
 *   including this one).
 *
 * Throws {@link ConflictError} naming the conflicting MCP. `excludeMcpId` is
 * the row being updated, so it does not conflict with itself.
 */
export const assertMcpSlugAvailable = async (
  slug: string,
  scope: { orgId: string },
  excludeMcpId?: string,
): Promise<void> => {
  // A left join so an org-scoped row (whose `workspaceId` is null) still
  // appears — its own `organizationId` branch below is what matches it.
  const [conflict] = await db
    .select({ id: mcpTable.id, name: mcpTable.name })
    .from(mcpTable)
    .leftJoin(workspaceTable, eq(mcpTable.workspaceId, workspaceTable.id))
    .where(
      and(
        eq(mcpTable.slug, slug),
        excludeMcpId ? ne(mcpTable.id, excludeMcpId) : undefined,
        or(
          eq(mcpTable.organizationId, scope.orgId),
          eq(workspaceTable.organizationId, scope.orgId),
        ),
      ),
    )
    .limit(1);

  if (conflict) {
    throw new ConflictError(
      `Another MCP ("${conflict.name}") in this Organization already resolves to the tool-namespace slug "${slug}"; rename one of them`,
    );
  }
};
