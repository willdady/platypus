import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockNanoid } from "../test-setup.ts";
import {
  mockNoSession,
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
  type Store,
} from "../test-utils.ts";

const { mockValidateCronExpression } = vi.hoisted(() => ({
  mockValidateCronExpression:
    vi.fn<(cronExpression: string, timezone: string) => Date | null>(),
}));

vi.mock("../utils/cron.ts", () => ({
  validateCronExpression: mockValidateCronExpression,
  nextCronRunAt: (config: { cronExpression: string; timezone: string }) =>
    mockValidateCronExpression(config.cronExpression, config.timezone),
}));

mockNanoid.mockReturnValue("trig-new");

import app from "../server.ts";

const orgId = "org-1";
const workspaceId = "ws-1";
const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/triggers`;

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});

const cronTrigger = {
  id: "trig-1",
  workspaceId,
  agentId: "agent-1",
  type: "cron" as const,
  name: "Daily",
  description: null,
  instruction: "Do something",
  enabled: true,
  maxRunsToKeep: 10,
  search: false,
  includeMemories: false,
  config: { cronExpression: "0 9 * * *", timezone: "UTC", isOneOff: false },
  lastRunAt: null,
  nextRunAt: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const eventTrigger = {
  ...cronTrigger,
  id: "trig-2",
  type: "event" as const,
  config: { events: ["card.created"] },
};

const agentRow = (over: Row = {}): Row => ({
  id: "agent-1",
  organizationId: orgId,
  workspaceId,
  ...over,
});

const world = (rows: Store = {}): FakeDb =>
  seedDb({
    organization_member: [
      {
        id: "member-1",
        organizationId: orgId,
        userId: "user-1",
        role: "member",
      },
    ],
    workspace: [
      {
        id: workspaceId,
        organizationId: orgId,
        ownerId: "user-1",
        name: "Support",
      },
    ],
    agent: [agentRow()],
    ...rows,
  });

describe("Trigger Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  describe("GET /", () => {
    it("lists all triggers in the workspace", async () => {
      mockSession();
      world({
        trigger: [
          cronTrigger,
          eventTrigger,
          { ...cronTrigger, id: "trig-other-ws", workspaceId: "ws-2" },
        ],
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: unknown[] };
      expect(body.results).toHaveLength(2);
    });

    it("leaves fired One-off Triggers out unless includeFired=true", async () => {
      const fired = {
        ...cronTrigger,
        id: "trig-fired",
        enabled: false,
        config: { ...cronTrigger.config, isOneOff: true },
        firedAt: new Date("2026-01-02"),
      };
      const list = async (query: string) => {
        mockSession();
        world({
          trigger: [cronTrigger, fired],
          trigger_run: [
            {
              id: "run-fired",
              triggerId: "trig-fired",
              status: "success",
              startedAt: new Date("2026-01-02T09:00:00Z"),
            },
          ],
        });
        const res = await app.request(`${baseUrl}${query}`);
        expect(res.status).toBe(200);
        return (
          (await res.json()) as {
            results: {
              id: string;
              lastRunStatus: string | null;
              lastRunStartedAt: string | null;
            }[];
          }
        ).results.map(({ id, lastRunStatus, lastRunStartedAt }) => ({
          id,
          lastRunStatus,
          lastRunStartedAt,
        }));
      };

      expect(await list("")).toEqual([
        { id: "trig-1", lastRunStatus: null, lastRunStartedAt: null },
      ]);
      expect(await list("?includeFired=true")).toEqual([
        { id: "trig-1", lastRunStatus: null, lastRunStartedAt: null },
        {
          id: "trig-fired",
          lastRunStatus: "success",
          lastRunStartedAt: "2026-01-02T09:00:00.000Z",
        },
      ]);
    });

    it("rejects an unknown query key", async () => {
      mockSession();
      world();

      const res = await app.request(`${baseUrl}?includeFired=true&foo=1`);

      expect(res.status).toBe(400);
    });

    it("never returns an Inbound Trigger's token hash", async () => {
      mockSession();
      world({
        trigger: [
          {
            ...cronTrigger,
            type: "inbound",
            config: { inputs: [], tokenExpiryDays: 90 },
            tokenHash: "secret-hash",
            tokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
            tokenNotice: "expiring_30",
          },
        ],
      });

      const res = await app.request(baseUrl);
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(text).not.toContain("secret-hash");
      expect(text).not.toContain("tokenNotice");
      const body = JSON.parse(text) as { results: { tokenStatus: string }[] };
      expect(body.results[0].tokenStatus).toBe("active");
    });

    it("requires authentication", async () => {
      mockNoSession();
      const res = await app.request(baseUrl);
      expect(res.status).toBe(401);
    });
  });

  describe("GET /:triggerId", () => {
    it("returns the trigger when found", async () => {
      mockSession();
      world({ trigger: [cronTrigger] });

      const res = await app.request(`${baseUrl}/trig-1`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ id: "trig-1", agentId: "agent-1" });
    });

    it("returns 404 when not found in this workspace", async () => {
      mockSession();
      world({
        trigger: [{ ...cronTrigger, id: "trig-missing", workspaceId: "ws-2" }],
      });

      const res = await app.request(`${baseUrl}/trig-missing`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Trigger not found" });
    });
  });

  describe("POST /", () => {
    const createBody = {
      workspaceId,
      agentId: "agent-1",
      type: "cron",
      name: "Daily",
      instruction: "Do something",
      enabled: true,
      maxRunsToKeep: 10,
      search: false,
      config: { cronExpression: "0 9 * * *", timezone: "UTC", isOneOff: false },
    };

    it("creates a cron trigger and returns 201", async () => {
      mockSession();
      const fake = world();
      const nextRun = new Date("2026-02-01T09:00:00Z");
      mockValidateCronExpression.mockReturnValueOnce(nextRun);

      const res = await app.request(baseUrl, json("POST", createBody));
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; nextRunAt: string };
      expect(body.id).toBe("trig-new");
      expect(body.nextRunAt).toBe(nextRun.toISOString());
      expect(fake.tables.trigger).toMatchObject([
        {
          id: "trig-new",
          workspaceId,
          agentId: "agent-1",
          type: "cron",
          nextRunAt: nextRun,
        },
      ]);
    });

    it("creates an Inbound Trigger with no token when the body opts out", async () => {
      mockSession();
      const fake = world();
      const inboundBody = {
        ...createBody,
        type: "inbound",
        enabled: false,
        issueToken: false,
        config: { inputs: [], tokenExpiryDays: 90 },
      };

      const res = await app.request(baseUrl, json("POST", inboundBody));
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("token");
      expect(body.tokenStatus).toBe("none");
      const values = fake.tables.trigger.at(-1)!;
      expect(values).not.toHaveProperty("tokenHash");
    });

    it("creates an event trigger with a full filters shape (columnId, changedFields) and returns 201", async () => {
      mockSession();
      const fake = world();
      const eventBody = {
        ...createBody,
        type: "event",
        config: {
          events: ["card.created", "card.updated"],
          filters: {
            boardId: "board-1",
            columnId: "col-1",
            changedFields: ["title"],
          },
        },
      };

      const res = await app.request(baseUrl, json("POST", eventBody));
      expect(res.status).toBe(201);
      const body = (await res.json()) as { config: unknown };
      expect(body.config).toEqual(eventBody.config);
      const values = fake.tables.trigger.at(-1)!;
      expect(values.config).toEqual(eventBody.config);
    });

    it("defaults includeMemories and extractMemories off when the create body omits them, and writes them when set", async () => {
      mockSession();
      const fake = world();
      mockValidateCronExpression.mockReturnValueOnce(
        new Date("2026-02-01T09:00:00Z"),
      );

      const res = await app.request(baseUrl, json("POST", createBody));
      expect(res.status).toBe(201);
      const values = fake.tables.trigger.at(-1)!;
      expect(values.includeMemories).toBe(false);
      expect(values.extractMemories).toBe(false);

      const optedInFake = world();
      mockValidateCronExpression.mockReturnValueOnce(
        new Date("2026-02-01T09:00:00Z"),
      );

      const optedIn = await app.request(
        baseUrl,
        json("POST", {
          ...createBody,
          includeMemories: true,
          extractMemories: true,
        }),
      );
      expect(optedIn.status).toBe(201);
      const optedInValues = optedInFake.tables.trigger.at(-1)!;
      expect(optedInValues.includeMemories).toBe(true);
      expect(optedInValues.extractMemories).toBe(true);
      const body = (await optedIn.json()) as { includeMemories: boolean };
      expect(body.includeMemories).toBe(true);
    });

    it("accepts a Shared agent attached to this workspace", async () => {
      mockSession();
      const fake = world({
        agent: [agentRow({ organizationId: orgId, workspaceId: null })],
        attachment: [
          {
            id: "att-1",
            workspaceId,
            resourceType: "agent",
            resourceId: "agent-1",
          },
        ],
      });
      const nextRun = new Date("2026-02-01T09:00:00Z");
      mockValidateCronExpression.mockReturnValueOnce(nextRun);

      const res = await app.request(baseUrl, json("POST", createBody));
      expect(res.status).toBe(201);
      expect(fake.tables.trigger).toMatchObject([
        { id: "trig-new", agentId: "agent-1", nextRunAt: nextRun },
      ]);
    });

    it.each([
      [
        "a cron config for an Inbound Trigger",
        { type: "inbound", config: { cronExpression: "* * * * *" } },
      ],
      ["an unknown event", { type: "event", config: { events: ["bogus"] } }],
      [
        "a Webhook-only trigger_run event",
        { type: "event", config: { events: ["trigger_run.failed"] } },
      ],
      ["an inbound config for a Cron Trigger", { type: "cron", config: {} }],
    ])(
      "validates the config against its own type, refusing %s",
      async (_label, override) => {
        mockSession();
        const fake = world();

        const res = await app.request(
          baseUrl,
          json("POST", { ...createBody, ...override }),
        );

        expect(res.status).toBe(400);
        expect(fake.queries.filter((q) => q.kind === "insert")).toEqual([]);
      },
    );

    it("rejects creation when the agent is not in the workspace", async () => {
      mockSession();
      world({ agent: [agentRow({ workspaceId: "ws-2" })] });

      const res = await app.request(baseUrl, json("POST", createBody));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Agent not found in this workspace",
      });
    });
  });

  describe("PUT /:triggerId", () => {
    it("updates a trigger and recomputes nextRunAt when the cron config changes", async () => {
      mockSession();
      const fake = world({ trigger: [cronTrigger] });
      const nextRun = new Date("2026-02-02T09:00:00Z");
      mockValidateCronExpression.mockReturnValueOnce(nextRun);

      const res = await app.request(
        `${baseUrl}/trig-1`,
        json("PATCH", {
          name: "Updated",
          config: {
            cronExpression: "0 10 * * *",
            timezone: "UTC",
            isOneOff: false,
          },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe("Updated");
      expect(fake.tables.trigger).toMatchObject([
        {
          id: "trig-1",
          name: "Updated",
          nextRunAt: nextRun,
          config: {
            cronExpression: "0 10 * * *",
            timezone: "UTC",
            isOneOff: false,
          },
        },
      ]);
    });

    it("returns 404 when the trigger doesn't exist in this workspace", async () => {
      mockSession();
      world({
        trigger: [{ ...cronTrigger, id: "trig-missing", workspaceId: "ws-2" }],
      });

      const res = await app.request(
        `${baseUrl}/trig-missing`,
        json("PATCH", { name: "x" }),
      );
      expect(res.status).toBe(404);
    });

    it("rejects an agent change when the new agent is not in the workspace", async () => {
      mockSession();
      world({
        trigger: [cronTrigger],
        agent: [
          agentRow(),
          agentRow({ id: "agent-other", workspaceId: "ws-2" }),
        ],
      });

      const res = await app.request(
        `${baseUrl}/trig-1`,
        json("PATCH", { agentId: "agent-other" }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Agent not found in this workspace",
      });
    });

    it("returns 404 for a missing trigger before checking the new agent", async () => {
      mockSession();
      world({ agent: [agentRow({ id: "agent-other", workspaceId: "ws-2" })] });

      const res = await app.request(
        `${baseUrl}/trig-missing`,
        json("PATCH", { agentId: "agent-other" }),
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Trigger not found" });
    });

    it("round-trips a columnId/changedFields filter through a config update", async () => {
      mockSession();
      const fake = world({ trigger: [eventTrigger] });
      const newConfig = {
        events: ["card.updated"],
        filters: {
          boardId: "board-1",
          columnId: "col-2",
          changedFields: ["priority"],
        },
      };

      const res = await app.request(
        `${baseUrl}/trig-2`,
        json("PATCH", { config: newConfig }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { config: unknown };
      expect(body.config).toEqual(newConfig);
      const stored = fake.tables.trigger.find((row) => row.id === "trig-2")!;
      expect(stored.config).toEqual(newConfig);
    });

    it("clears nextRunAt when switching to event type", async () => {
      mockSession();
      const fake = world({
        trigger: [
          { ...cronTrigger, nextRunAt: new Date("2026-02-01T09:00:00.000Z") },
        ],
      });

      const res = await app.request(
        `${baseUrl}/trig-1`,
        json("PATCH", {
          type: "event",
          config: { events: ["card.created"] },
        }),
      );
      expect(res.status).toBe(200);
      const stored = fake.tables.trigger.find((row) => row.id === "trig-1")!;
      expect(stored.type).toBe("event");
      expect(stored.nextRunAt).toBeNull();
    });

    it("leaves the settings a toggle does not mention unchanged", async () => {
      mockSession();
      const fake = world({
        trigger: [
          {
            ...cronTrigger,
            maxRunsToKeep: 10,
            search: true,
            includeMemories: true,
          },
        ],
      });

      const res = await app.request(
        `${baseUrl}/trig-1`,
        json("PATCH", { enabled: false }),
      );
      expect(res.status).toBe(200);
      expect(fake.tables.trigger[0]).toMatchObject({
        enabled: false,
        maxRunsToKeep: 10,
        search: true,
        includeMemories: true,
        name: "Daily",
      });
    });

    it("round-trips includeMemories through an update", async () => {
      mockSession();
      const fake = world({ trigger: [cronTrigger] });

      const res = await app.request(
        `${baseUrl}/trig-1`,
        json("PATCH", { includeMemories: true }),
      );
      expect(res.status).toBe(200);
      const stored = fake.tables.trigger.find((row) => row.id === "trig-1")!;
      expect(stored.includeMemories).toBe(true);
      const body = (await res.json()) as { includeMemories: boolean };
      expect(body.includeMemories).toBe(true);
    });
  });

  describe("DELETE /:triggerId", () => {
    const deleteWorld = (triggers: Row[] = []) => {
      mockSession();
      return world({ trigger: triggers });
    };

    it("deletes the trigger when found", async () => {
      const fake = deleteWorld([cronTrigger]);

      const res = await app.request(`${baseUrl}/trig-1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Trigger deleted" });
      expect(fake.tables.trigger).toHaveLength(0);
    });

    it("deletes an Inbound Trigger: the Owner's surface may", async () => {
      const fake = deleteWorld([{ ...cronTrigger, type: "inbound" }]);

      const res = await app.request(`${baseUrl}/trig-1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(fake.tables.trigger).toHaveLength(0);
    });

    it("returns 404 when the trigger doesn't exist", async () => {
      deleteWorld();

      const res = await app.request(`${baseUrl}/trig-missing`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });
});
