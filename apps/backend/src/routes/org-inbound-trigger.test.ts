import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import { ConflictError } from "../errors.ts";

vi.mock("../services/inbound-trigger.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/inbound-trigger.ts")>()),
  listOrgInboundTriggers: vi.fn(),
  revokeInboundTriggerToken: vi.fn(),
  getInboundTriggerAccess: vi.fn(),
  setInboundTriggerAccess: vi.fn(),
}));

import app from "../server.ts";
import {
  getInboundTriggerAccess,
  listOrgInboundTriggers,
  revokeInboundTriggerToken,
  setInboundTriggerAccess,
} from "../services/inbound-trigger.ts";

const baseUrl = "/organizations/org-1/inbound-triggers";

const asRole = (role: "admin" | "member") => {
  mockSession();
  mockDb.limit.mockResolvedValueOnce([{ role }]); // requireOrgAccess
};

describe("Org Inbound Trigger Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  it("lists the Organization's Inbound Triggers for an Org Admin", async () => {
    asRole("admin");
    vi.mocked(listOrgInboundTriggers).mockResolvedValueOnce([]);

    const res = await app.request(baseUrl);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
    expect(listOrgInboundTriggers).toHaveBeenCalledWith("org-1");
  });

  const SEEN = "2026-07-01T10:00:00.000Z";

  it("revokes the token the Org Admin saw", async () => {
    asRole("admin");
    vi.mocked(revokeInboundTriggerToken).mockResolvedValueOnce(true);

    const res = await app.request(
      `${baseUrl}/trig-1/token?tokenCreatedAt=${SEEN}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(200);
    expect(revokeInboundTriggerToken).toHaveBeenCalledWith(
      "org-1",
      "trig-1",
      new Date(SEEN),
    );
  });

  it("409s when the token was replaced since the list loaded", async () => {
    asRole("admin");
    vi.mocked(revokeInboundTriggerToken).mockRejectedValueOnce(
      new ConflictError("The token was replaced since you loaded the list."),
    );

    const res = await app.request(
      `${baseUrl}/trig-1/token?tokenCreatedAt=${SEEN}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(409);
  });

  it.each(["", "?tokenCreatedAt=", "?tokenCreatedAt=yesterday"])(
    "400s a revoke that doesn't name the token (%s)",
    async (query) => {
      asRole("admin");

      const res = await app.request(`${baseUrl}/trig-1/token${query}`, {
        method: "DELETE",
      });

      expect(res.status).toBe(400);
      expect(revokeInboundTriggerToken).not.toHaveBeenCalled();
    },
  );

  it("404s a revoke of a Trigger not in the Organization", async () => {
    asRole("admin");
    vi.mocked(revokeInboundTriggerToken).mockResolvedValueOnce(false);

    const res = await app.request(
      `${baseUrl}/trig-x/token?tokenCreatedAt=${SEEN}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(404);
  });

  const ACCESS = {
    gate: "selected",
    workspaces: [
      {
        id: "ws-1",
        name: "Support",
        ownerName: "Dana Owner",
        allowed: true,
        count: 2,
      },
    ],
  };

  it("reads the gate and every Workspace's switch for an Org Admin", async () => {
    asRole("admin");
    vi.mocked(getInboundTriggerAccess).mockResolvedValueOnce(
      ACCESS as Awaited<ReturnType<typeof getInboundTriggerAccess>>,
    );

    const res = await app.request(`${baseUrl}/access`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ACCESS);
    expect(getInboundTriggerAccess).toHaveBeenCalledWith("org-1");
  });

  it("saves the gate with the allowed Workspaces in one call", async () => {
    asRole("admin");
    vi.mocked(setInboundTriggerAccess).mockResolvedValueOnce(
      ACCESS as Awaited<ReturnType<typeof setInboundTriggerAccess>>,
    );

    const res = await app.request(`${baseUrl}/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gate: "selected", allowedWorkspaceIds: ["ws-1"] }),
    });

    expect(res.status).toBe(200);
    expect(setInboundTriggerAccess).toHaveBeenCalledWith(
      "org-1",
      { gate: "selected", allowedWorkspaceIds: ["ws-1"] },
      expect.any(String),
    );
  });

  it.each([
    { gate: "everyone" },
    {},
    { gate: "all", allowedWorkspaceIds: "ws-1" },
  ])("400s an access save that isn't a gate (%j)", async (body) => {
    asRole("admin");

    const res = await app.request(`${baseUrl}/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    expect(setInboundTriggerAccess).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", baseUrl],
    ["DELETE", `${baseUrl}/trig-1/token`],
    ["GET", `${baseUrl}/access`],
    ["PUT", `${baseUrl}/access`],
  ])("refuses %s to a member who is not an Org Admin", async (method, url) => {
    asRole("member");

    const res = await app.request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(method === "PUT" ? { body: JSON.stringify({ gate: "all" }) } : {}),
    });

    expect(res.status).toBe(403);
    expect(listOrgInboundTriggers).not.toHaveBeenCalled();
    expect(revokeInboundTriggerToken).not.toHaveBeenCalled();
    expect(getInboundTriggerAccess).not.toHaveBeenCalled();
    expect(setInboundTriggerAccess).not.toHaveBeenCalled();
  });
});
