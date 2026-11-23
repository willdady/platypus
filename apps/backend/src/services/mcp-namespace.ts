import { and, eq, ne, or } from "drizzle-orm";
import { slugifyMcpName } from "@platypus/schemas";
import { db } from "../index.ts";
import { mcp as mcpTable, workspace as workspaceTable } from "../db/schema.ts";
import { ConflictError } from "../errors.ts";

export const deriveMcpSlug = slugifyMcpName;

export const assertMcpSlugAvailable = async (
  slug: string,
  scope: { orgId: string },
  excludeMcpId?: string,
): Promise<void> => {
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
