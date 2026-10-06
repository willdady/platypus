import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockSession, resetMockDb, seedDb } from "../test-utils.ts";
import app from "../server.ts";

const accessUrl = "/organizations/org-1/a2a/access";

/** `user-1` is the caller, with `role` in `org-1`. */
const seed = (role: "admin" | "member" = "admin") => {
  mockSession();
  return seedDb({
    organization_member: [
      { id: "m1", userId: "user-1", organizationId: "org-1", role },
    ],
    organization: [
      { id: "org-1", name: "Acme", a2aGate: "off", inboundTriggerGate: "all" },
    ],
    user: [{ id: "user-1", name: "Dana Owner" }],
    workspace: [
      {
        id: "ws-1",
        organizationId: "org-1",
        ownerId: "user-1",
        name: "Support",
        a2aAllowed: false,
        inboundTriggersAllowed: true,
      },
      {
        id: "ws-2",
        organizationId: "org-1",
        ownerId: "user-1",
        name: "Billing",
        a2aAllowed: true,
        inboundTriggersAllowed: false,
      },
    ],
    a2a_endpoint: [
      { id: "ep-1", workspaceId: "ws-1", agentId: "agent-1" },
      { id: "ep-2", workspaceId: "ws-1", agentId: "agent-1" },
    ],
  });
};

const put = (body: unknown) =>
  app.request(accessUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("Org A2A gate routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  it("is off by default and lists every Workspace with its endpoint count", async () => {
    seed();

    const res = await app.request(accessUrl);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      gate: "off",
      workspaces: [
        {
          id: "ws-2",
          name: "Billing",
          ownerName: "Dana Owner",
          allowed: true,
          count: 0,
        },
        {
          id: "ws-1",
          name: "Support",
          ownerName: "Dana Owner",
          allowed: false,
          count: 2,
        },
      ],
    });
  });

  it("saves the gate and the selected Workspaces without touching the Inbound Trigger gate", async () => {
    const fake = seed();

    const res = await put({ gate: "selected", allowedWorkspaceIds: ["ws-1"] });

    expect(res.status).toBe(200);
    expect(fake.tables.organization[0]).toMatchObject({
      a2aGate: "selected",
      inboundTriggerGate: "all",
    });
    expect(
      fake.tables.workspace.map((ws) => [
        ws.id,
        ws.a2aAllowed,
        ws.inboundTriggersAllowed,
      ]),
    ).toEqual([
      ["ws-1", true, true],
      ["ws-2", false, false],
    ]);
  });

  it("400s a gate it doesn't know", async () => {
    const fake = seed();

    expect((await put({ gate: "everyone" })).status).toBe(400);
    expect(fake.tables.organization[0].a2aGate).toBe("off");
  });

  it.each(["GET", "PUT"])(
    "refuses %s to a member who is not an Org Admin",
    async (method) => {
      const fake = seed("member");

      const res = await app.request(accessUrl, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "PUT" ? { body: JSON.stringify({ gate: "all" }) } : {}),
      });

      expect(res.status).toBe(403);
      expect(fake.tables.organization[0].a2aGate).toBe("off");
    },
  );
});
