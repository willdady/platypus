import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockSession,
  resetMockDb,
  seedDb,
  type Store,
  type Row,
} from "../test-utils.ts";
import app from "../server.ts";

describe("Organization Tool Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/tools`;

  const mcp = (over: Row = {}): Row => ({
    id: "mcp-1",
    name: "Shared MCP",
    organizationId: orgId,
    workspaceId: null,
    ...over,
  });

  const world = (role: "admin" | "member" = "member", rows: Store = {}) =>
    seedDb({
      organization_member: [
        { id: "m1", userId: "user-1", organizationId: orgId, role },
      ],
      mcp: [
        mcp(),
        mcp({ id: "mcp-other-org", organizationId: "org-2" }),
        mcp({ id: "mcp-ws", organizationId: null, workspaceId: "ws-1" }),
      ],
      ...rows,
    });

  it("lists static tool sets plus org-scoped MCPs for any member", async () => {
    mockSession();
    world("member");

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
    expect(
      body.results.filter((t) => t.category === "MCP").map((t) => t.id),
    ).toEqual(["mcp-1"]);
    expect(body.results.some((t) => t.category !== "MCP")).toBe(true);
  });

  it("returns 403 when not a member of the organization", async () => {
    mockSession();
    seedDb({});

    const res = await app.request(baseUrl);
    expect(res.status).toBe(403);
  });
});
