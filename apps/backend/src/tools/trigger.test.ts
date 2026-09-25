import { describe, it, expect, vi, beforeEach } from "vitest";
import { callTool, resetMockDb, seedDb } from "../test-utils.ts";

// The Trigger rules (config validation, nextRunAt, agent visibility, workspace
// scoping of reads and writes) are unit-tested in services/trigger.test.ts;
// here the Trigger module is a seam and this file covers the adapter: which
// fields it forwards, how it shapes a result, and how it reports a refusal.
vi.mock("../services/trigger.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/trigger.ts")>()),
  createTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  listTriggers: vi.fn(),
  getTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
}));

import { createTriggerTools } from "./trigger.ts";
import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  listTriggers,
  updateTrigger,
} from "../services/trigger.ts";
import { NotFoundError, ValidationError } from "../errors.ts";

const workspaceId = "ws-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";
const ctx = { orgId, workspaceId };

const cronCreate = {
  label: "Daily",
  name: "Daily",
  agentId: "a1",
  instruction: "Run daily",
  type: "cron" as const,
  config: { cronExpression: "0 9 * * *" },
  description: "Runs every day",
};

describe("createTriggerTools", () => {
  let tools: ReturnType<typeof createTriggerTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    tools = createTriggerTools(workspaceId, orgId, frontendUrl);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "listAgents",
      "listTriggers",
      "getTrigger",
      "upsertTrigger",
      "deleteTrigger",
    ]);
  });

  it("listAgents returns this workspace's agents and attached Shared ones, newest first", async () => {
    const agent = (id: string, scope: object, createdAt: string) => ({
      id,
      name: id,
      description: `${id} description`,
      workspaceId: null,
      organizationId: null,
      createdAt: new Date(createdAt),
      ...scope,
    });
    const attached = (resourceId: string, ws = workspaceId) => ({
      id: `att-${resourceId}`,
      workspaceId: ws,
      resourceType: "agent",
      resourceId,
    });
    seedDb({
      agent: [
        agent("mine", { workspaceId }, "2024-01-01"),
        agent("shared", { organizationId: orgId }, "2024-02-01"),
        agent("elsewhere", { workspaceId: "ws-2" }, "2024-03-01"),
        agent("unattached", { organizationId: orgId }, "2024-04-01"),
      ],
      attachment: [attached("shared"), attached("unattached", "ws-2")],
    });

    expect(await callTool(tools.listAgents, {})).toEqual({
      agents: [
        { id: "shared", name: "shared", description: "shared description" },
        { id: "mine", name: "mine", description: "mine description" },
      ],
      count: 2,
    });
  });

  it("listTriggers forwards enabledOnly and returns a summary of each trigger", async () => {
    const createdAt = new Date("2026-01-01");
    vi.mocked(listTriggers).mockResolvedValueOnce([
      {
        id: "t1",
        name: "Daily",
        description: "d",
        agentId: "a1",
        type: "cron",
        enabled: true,
        nextRunAt: null,
        lastRunAt: null,
        createdAt,
        instruction: "a long prompt the summary leaves out",
        config: { cronExpression: "0 9 * * *" },
      },
    ] as never);

    expect(await callTool(tools.listTriggers, { enabledOnly: true })).toEqual({
      triggers: [
        {
          id: "t1",
          name: "Daily",
          description: "d",
          agentId: "a1",
          type: "cron",
          enabled: true,
          nextRunAt: null,
          lastRunAt: null,
          createdAt,
        },
      ],
      count: 1,
    });
    expect(listTriggers).toHaveBeenCalledWith(ctx, { enabledOnly: true });
  });

  describe("getTrigger", () => {
    it("returns the trigger in full", async () => {
      const trigger = { id: "t1", instruction: "Do something" };
      vi.mocked(getTrigger).mockResolvedValueOnce(trigger as never);

      expect(await callTool(tools.getTrigger, { triggerId: "t1" })).toEqual({
        trigger,
      });
      expect(getTrigger).toHaveBeenCalledWith(ctx, "t1");
    });

    it("points at listTriggers when the trigger is not found", async () => {
      vi.mocked(getTrigger).mockRejectedValueOnce(new NotFoundError());

      expect(await callTool(tools.getTrigger, { triggerId: "t1" })).toEqual({
        error:
          "Trigger not found in this workspace. Use listTriggers to find valid IDs.",
      });
    });

    it("lets any other failure throw", async () => {
      vi.mocked(getTrigger).mockRejectedValueOnce(new Error("connection lost"));

      await expect(
        callTool(tools.getTrigger, { triggerId: "t1" }),
      ).rejects.toThrow("connection lost");
    });
  });

  describe("upsertTrigger", () => {
    it("creates through the Trigger module and links the new trigger", async () => {
      vi.mocked(createTrigger).mockResolvedValueOnce({ id: "t9" } as never);

      expect(
        await callTool(tools.upsertTrigger, {
          ...cronCreate,
          includeMemories: true,
        }),
      ).toEqual({
        success: true,
        trigger: { id: "t9" },
        url: "http://localhost:3000/org-1/workspace/ws-1/triggers/t9",
      });
      expect(createTrigger).toHaveBeenCalledWith(ctx, {
        agentId: "a1",
        type: "cron",
        name: "Daily",
        description: "Runs every day",
        instruction: "Run daily",
        enabled: undefined,
        maxRunsToKeep: undefined,
        search: undefined,
        includeMemories: true,
        config: { cronExpression: "0 9 * * *" },
      });
    });

    it.each(["name", "agentId", "instruction", "type", "config"] as const)(
      "refuses a create without %s",
      async (field) => {
        const input: Record<string, unknown> = { ...cronCreate };
        delete input[field];

        expect(
          await callTool(tools.upsertTrigger, input as typeof cronCreate),
        ).toEqual({
          error:
            "name, agentId, instruction, type, and config are required when creating a new trigger",
        });
        expect(createTrigger).not.toHaveBeenCalled();
      },
    );

    it("updates by triggerId, forwarding only what the call carries, and links it", async () => {
      vi.mocked(updateTrigger).mockResolvedValueOnce({ id: "t1" } as never);

      expect(
        await callTool(tools.upsertTrigger, {
          triggerId: "t1",
          label: "Daily",
          description: "Runs every day",
          includeMemories: true,
        }),
      ).toEqual({
        success: true,
        trigger: { id: "t1" },
        url: "http://localhost:3000/org-1/workspace/ws-1/triggers/t1",
      });
      expect(updateTrigger).toHaveBeenCalledWith(
        ctx,
        "t1",
        expect.objectContaining({
          description: "Runs every day",
          includeMemories: true,
          agentId: undefined,
          config: undefined,
        }),
      );
      expect(createTrigger).not.toHaveBeenCalled();
    });

    describe.each([
      {
        mode: "create",
        service: createTrigger,
        input: cronCreate,
      },
      {
        mode: "update",
        service: updateTrigger,
        input: { ...cronCreate, triggerId: "t1" },
      },
    ])("$mode refusals", ({ service, input }) => {
      it.each([
        [
          new NotFoundError("Agent not found in this workspace"),
          "Agent not found in this workspace. Use listAgents to find valid agent IDs.",
        ],
        [new NotFoundError("Trigger not found"), "Trigger not found"],
        [
          new ValidationError("Invalid cron expression"),
          "Invalid cron expression",
        ],
      ])("reports %s as a failed result", async (error, message) => {
        vi.mocked(service).mockRejectedValueOnce(error);

        expect(await callTool(tools.upsertTrigger, input)).toEqual({
          success: false,
          error: message,
        });
      });

      it("lets any other failure throw", async () => {
        vi.mocked(service).mockRejectedValueOnce(new Error("connection lost"));

        await expect(callTool(tools.upsertTrigger, input)).rejects.toThrow(
          "connection lost",
        );
      });
    });
  });

  describe("deleteTrigger", () => {
    it("deletes this workspace's trigger", async () => {
      vi.mocked(deleteTrigger).mockResolvedValueOnce(true);

      expect(
        await callTool(tools.deleteTrigger, { triggerId: "t1", label: "x" }),
      ).toEqual({ success: true });
      expect(deleteTrigger).toHaveBeenCalledWith(ctx, "t1");
    });

    it("returns an error when nothing was deleted", async () => {
      vi.mocked(deleteTrigger).mockResolvedValueOnce(false);

      expect(
        await callTool(tools.deleteTrigger, { triggerId: "t1", label: "x" }),
      ).toEqual({ error: "Trigger not found" });
    });
  });
});
