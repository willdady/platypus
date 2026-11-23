import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

describe("Organization Tool Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/tools`;

  it("lists static tool sets plus org-scoped MCPs for any member", async () => {
    mockSession();
    mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
    mockDb.where
      .mockReturnValueOnce(mockDb)
      .mockResolvedValueOnce([
        { id: "mcp-1", name: "Shared MCP", organizationId: orgId },
      ]);

    const res = await app.request(baseUrl);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { id: string; name: string; category: string }[];
    };
    expect(body.results).toContainEqual({
      id: "mcp-1",
      name: "Shared MCP",
      category: "MCP",
    });
    expect(body.results.some((t) => t.category !== "MCP")).toBe(true);
  });

  it("returns 403 when not a member of the organization", async () => {
    mockSession();
    mockDb.limit.mockResolvedValueOnce([]);

    const res = await app.request(baseUrl);
    expect(res.status).toBe(403);
  });
});
