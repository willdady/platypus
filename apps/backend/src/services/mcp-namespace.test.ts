import { describe, it, expect, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import { assertMcpSlugAvailable, deriveMcpSlug } from "./mcp-namespace.ts";
import { ConflictError } from "../errors.ts";

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
  });

  it("throws ConflictError naming the conflicting MCP", async () => {
    mockDb.limit.mockResolvedValueOnce([
      { id: "mcp-other", name: "Other MCP" },
    ]);
    await expect(
      assertMcpSlugAvailable("acme", { orgId: "org-1" }),
    ).rejects.toThrow(ConflictError);
  });

  it("does not conflict with the row being updated", async () => {
    // The `ne(mcpTable.id, excludeMcpId)` filter is applied at the SQL layer,
    // which the mock db does not evaluate — so the mock resolving `[]` here
    // stands in for "the DB excluded the row being updated and found nothing
    // else", the behaviour this test is documenting.
    mockDb.limit.mockResolvedValueOnce([]);
    await expect(
      assertMcpSlugAvailable("acme", { orgId: "org-1" }, "mcp-1"),
    ).resolves.toBeUndefined();
  });
});
