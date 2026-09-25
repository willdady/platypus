import { describe, it, expect, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import { and, eq, ne, or } from "drizzle-orm";
import { mcp as mcpTable, workspace as workspaceTable } from "../db/schema.ts";
import { assertMcpSlugAvailable, deriveMcpSlug } from "./mcp-namespace.ts";
import { ConflictError } from "../errors.ts";

/** Either scope column naming this Organization — its Shared MCPs or its Workspaces'. */
const inOrg = (orgId: string) =>
  or(
    eq(mcpTable.organizationId, orgId),
    eq(workspaceTable.organizationId, orgId),
  );

describe("deriveMcpSlug", () => {
  it("is the same slugify rule the schema and the Tool session use", () => {
    expect(deriveMcpSlug("Mary's MCP Server")).toBe("marys_mcp_server");
  });
});

describe("assertMcpSlugAvailable", () => {
  beforeEach(() => {
    resetMockDb();
  });

  it("resolves when nothing else in the Organization resolves to this slug", async () => {
    mockDb.limit.mockResolvedValueOnce([]);
    await expect(
      assertMcpSlugAvailable("acme", { orgId: "org-1" }),
    ).resolves.toBeUndefined();
    // Every MCP in the Organization counts, Shared or Workspace-owned.
    expect(mockDb.where).toHaveBeenCalledWith(
      and(eq(mcpTable.slug, "acme"), undefined, inOrg("org-1")),
    );
  });

  it("throws ConflictError naming the conflicting MCP", async () => {
    mockDb.limit.mockResolvedValueOnce([
      { id: "mcp-other", name: "Other MCP" },
    ]);
    await expect(
      assertMcpSlugAvailable("acme", { orgId: "org-1" }),
    ).rejects.toThrow(
      new ConflictError(
        'Another MCP ("Other MCP") in this Organization already resolves to the tool-namespace slug "acme"; rename one of them',
      ),
    );
  });

  it("excludes the row being updated from the conflict search", async () => {
    mockDb.limit.mockResolvedValueOnce([]);
    await expect(
      assertMcpSlugAvailable("acme", { orgId: "org-1" }, "mcp-1"),
    ).resolves.toBeUndefined();
    expect(mockDb.where).toHaveBeenCalledWith(
      and(eq(mcpTable.slug, "acme"), ne(mcpTable.id, "mcp-1"), inOrg("org-1")),
    );
  });
});
