import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";
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
const timezone = "Australia/Melbourne";
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
    tools = createTriggerTools(workspaceId, orgId, frontendUrl, timezone);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "listAgents",
      "listTriggers",
      "getTrigger",
      "createTrigger",
      "updateTrigger",
      "deleteTrigger",
      "getCurrentTime",
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

  it("listTriggers forwards enabledOnly, includes fired One-offs, and returns a summary of each trigger", async () => {
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
        config: { cronExpression: "0 9 * * *", isOneOff: true },
        firedAt: createdAt,
        lastRunStatus: "success",
        lastRunStartedAt: createdAt,
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
          isOneOff: true,
          nextRunAt: null,
          lastRunAt: null,
          firedAt: createdAt,
          lastRunStatus: "success",
          lastRunStartedAt: createdAt,
          createdAt,
        },
      ],
      count: 1,
    });
    expect(listTriggers).toHaveBeenCalledWith(ctx, {
      enabledOnly: true,
      includeFired: true,
    });
  });

  describe("getTrigger", () => {
    it("returns the trigger in full, but never its token", async () => {
      const trigger = { id: "t1", instruction: "Do something" };
      vi.mocked(getTrigger).mockResolvedValueOnce({
        ...trigger,
        tokenHash: "secret-hash",
        tokenNotice: "expiring_30",
      } as never);

      expect(await callTool(tools.getTrigger, { triggerId: "t1" })).toEqual({
        trigger: { ...trigger, tokenStatus: "none" },
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

  describe("createTrigger", () => {
    it("creates through the Trigger module, in the acting User's timezone when none is given, and links the new trigger", async () => {
      vi.mocked(createTrigger).mockResolvedValueOnce({ id: "t9" } as never);

      expect(
        await callTool(tools.createTrigger, {
          ...cronCreate,
          includeMemories: true,
          extractMemories: true,
        }),
      ).toEqual({
        success: true,
        trigger: { id: "t9", tokenStatus: "none" },
        url: "http://localhost:3000/org-1/workspace/ws-1/triggers/t9",
      });
      expect(createTrigger).toHaveBeenCalledWith(
        ctx,
        {
          agentId: "a1",
          type: "cron",
          name: "Daily",
          description: "Runs every day",
          instruction: "Run daily",
          enabled: true,
          maxRunsToKeep: 10,
          search: false,
          includeMemories: true,
          extractMemories: true,
          config: {
            cronExpression: "0 9 * * *",
            timezone,
            isOneOff: false,
          },
        },
        { allowInbound: false },
      );
    });

    it("creates a One-off and echoes its next run in UTC and in its timezone", async () => {
      vi.mocked(createTrigger).mockResolvedValueOnce({
        id: "t9",
        type: "cron",
        config: {
          cronExpression: "0 9 11 10 *",
          timezone: "Australia/Sydney",
          isOneOff: true,
        },
        nextRunAt: new Date("2026-10-10T22:00:00.000Z"),
      } as never);

      expect(
        await callTool(tools.createTrigger, {
          ...cronCreate,
          config: {
            cronExpression: "0 9 11 10 *",
            timezone: "Australia/Sydney",
            isOneOff: true,
          },
        }),
      ).toMatchObject({
        success: true,
        nextRunAt: "2026-10-10T22:00:00.000Z",
        nextRunAtLocal: "Sunday, October 11, 2026 at 9:00:00 AM GMT+11",
      });
      expect(createTrigger).toHaveBeenCalledWith(
        ctx,
        expect.objectContaining({
          config: {
            cronExpression: "0 9 11 10 *",
            timezone: "Australia/Sydney",
            isOneOff: true,
          },
        }),
        { allowInbound: false },
      );
    });

    it("refuses an event create with no events before reaching the Trigger module", async () => {
      const result = (await callTool(tools.createTrigger, {
        ...cronCreate,
        type: "event",
        config: {},
      })) as { error: string };

      expect(result).not.toHaveProperty("success");
      expect(result.error).toContain("config.events");
      expect(createTrigger).not.toHaveBeenCalled();
    });

    // The AI SDK validates input against this schema before `execute` runs,
    // so a create missing a create-required field never reaches the module.
    it.each(["name", "agentId", "instruction", "type", "config"] as const)(
      "refuses a create without %s",
      (field) => {
        const input: Record<string, unknown> = { ...cronCreate };
        delete input[field];

        expect(
          (tools.createTrigger.inputSchema as z.ZodType).safeParse(input)
            .success,
        ).toBe(false);
        expect(createTrigger).not.toHaveBeenCalled();
      },
    );

    it("keeps Extract Memories in the create and update inputs", () => {
      const parsed = (tools.createTrigger.inputSchema as z.ZodType).parse({
        ...cronCreate,
        extractMemories: true,
      });
      expect(parsed).toMatchObject({ extractMemories: true });
      expect(
        (tools.updateTrigger.inputSchema as z.ZodType).parse({
          triggerId: "t1",
          label: "Daily",
          extractMemories: true,
        }),
      ).toMatchObject({ extractMemories: true });
    });
  });

  describe("updateTrigger", () => {
    it("updates by triggerId, forwarding only what the call carries, and links it", async () => {
      vi.mocked(updateTrigger).mockResolvedValueOnce({ id: "t1" } as never);

      expect(
        await callTool(tools.updateTrigger, {
          triggerId: "t1",
          label: "Daily",
          description: "Runs every day",
          includeMemories: true,
          extractMemories: true,
        }),
      ).toEqual({
        success: true,
        trigger: { id: "t1", tokenStatus: "none" },
        url: "http://localhost:3000/org-1/workspace/ws-1/triggers/t1",
      });
      expect(updateTrigger).toHaveBeenCalledWith(
        ctx,
        "t1",
        // Only what the call carried: a patch never rewrites a field it was
        // not given.
        {
          description: "Runs every day",
          includeMemories: true,
          extractMemories: true,
        },
        { allowInbound: false },
      );
      expect(createTrigger).not.toHaveBeenCalled();
    });

    it("runs a cron config the update left without a timezone in the acting User's zone", async () => {
      vi.mocked(updateTrigger).mockResolvedValueOnce({ id: "t1" } as never);

      await callTool(tools.updateTrigger, {
        triggerId: "t1",
        label: "Daily",
        config: { cronExpression: "0 9 * * *" },
      });

      expect(updateTrigger).toHaveBeenCalledWith(
        ctx,
        "t1",
        expect.objectContaining({
          config: { cronExpression: "0 9 * * *", timezone },
        }),
        { allowInbound: false },
      );
    });

    describe.each([
      {
        mode: "create",
        pick: (t: ReturnType<typeof createTriggerTools>) => t.createTrigger,
        service: createTrigger,
        input: cronCreate,
      },
      {
        mode: "update",
        pick: (t: ReturnType<typeof createTriggerTools>) => t.updateTrigger,
        service: updateTrigger,
        input: { ...cronCreate, triggerId: "t1" },
      },
    ])("$mode refusals", ({ pick, service, input }) => {
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

        expect(await callTool(pick(tools), input)).toEqual({
          error: message,
        });
      });

      it("lets any other failure throw", async () => {
        vi.mocked(service).mockRejectedValueOnce(new Error("connection lost"));

        await expect(callTool(pick(tools), input)).rejects.toThrow(
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
      expect(deleteTrigger).toHaveBeenCalledWith(ctx, "t1", {
        allowInbound: false,
      });
    });

    it("returns an error when nothing was deleted", async () => {
      vi.mocked(deleteTrigger).mockResolvedValueOnce(false);

      expect(
        await callTool(tools.deleteTrigger, { triggerId: "t1", label: "x" }),
      ).toEqual({ error: "Trigger not found" });
    });

    it("reports the refusal to delete an Inbound Trigger as a tool error", async () => {
      vi.mocked(deleteTrigger).mockRejectedValueOnce(
        new ValidationError("Inbound triggers can only be deleted in the UI"),
      );

      expect(
        await callTool(tools.deleteTrigger, { triggerId: "t1", label: "x" }),
      ).toEqual({
        error: "Inbound triggers can only be deleted in the UI",
      });
      // The tool never opts in to reaching Inbound Triggers.
      expect(deleteTrigger).toHaveBeenCalledWith(ctx, "t1", {
        allowInbound: false,
      });
    });
  });
});
