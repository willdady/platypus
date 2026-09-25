import { describe, it, expect, vi, beforeEach } from "vitest";
import { callTool } from "../test-utils.ts";

vi.mock("../services/agent.ts", () => ({
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
}));

import { createAgentManagementTools } from "./agent-management.ts";
import {
  createAgent as createAgentRow,
  updateAgent as updateAgentRow,
  deleteAgent as deleteAgentRow,
} from "../services/agent.ts";
import { LockedError, NotFoundError } from "../errors.ts";

// The write rules (dedupe, sub-agent validation, visibility, avatar cleanup)
// are unit-tested in services/agent.test.ts; this file covers the adapter:
// the scope it passes, how it shapes a row, and how it reports a refusal.

const workspaceId = "ws-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000/";
const scope = { kind: "workspace", ctx: { orgId, workspaceId } };

// Only the fields the adapter reads or strips; the rest pass through.
const row = (over: Record<string, unknown> = {}) =>
  ({
    row: { id: "a1", name: "Agent", avatarKey: "avatars/a1.png", ...over },
  }) as never;

const createInput = {
  name: "Agent",
  providerId: "p1",
  modelId: "alias:fast",
  maxSteps: 5,
};

describe("createAgentManagementTools", () => {
  let tools: ReturnType<typeof createAgentManagementTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    tools = createAgentManagementTools(workspaceId, orgId, frontendUrl);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "createAgent",
      "updateAgent",
      "deleteAgent",
    ]);
  });

  describe("createAgent", () => {
    it("creates in this workspace and returns the row without its avatar key, with a link", async () => {
      vi.mocked(createAgentRow).mockResolvedValueOnce(row());

      expect(await callTool(tools.createAgent, createInput)).toEqual({
        id: "a1",
        name: "Agent",
        url: "http://localhost:3000/org-1/workspace/ws-1/agents/a1",
      });
      expect(createAgentRow).toHaveBeenCalledWith(
        { orgId, workspaceId },
        createInput,
      );
    });

    it("omits the link when no frontend URL is configured", async () => {
      tools = createAgentManagementTools(workspaceId, orgId, undefined);
      vi.mocked(createAgentRow).mockResolvedValueOnce(row());

      expect(await callTool(tools.createAgent, createInput)).toEqual({
        id: "a1",
        name: "Agent",
      });
    });

    it("returns a rejected write as-is", async () => {
      vi.mocked(createAgentRow).mockResolvedValueOnce({
        error: "Circular dependency detected",
      });

      expect(await callTool(tools.createAgent, createInput)).toEqual({
        error: "Circular dependency detected",
      });
    });
  });

  describe("updateAgent", () => {
    it("updates at workspace scope without the display label and returns the shaped row", async () => {
      vi.mocked(updateAgentRow).mockResolvedValueOnce(row({ name: "New" }));

      expect(
        await callTool(tools.updateAgent, {
          agentId: "a1",
          label: "Agent",
          name: "New",
        }),
      ).toEqual({
        id: "a1",
        name: "New",
        url: "http://localhost:3000/org-1/workspace/ws-1/agents/a1",
      });
      expect(updateAgentRow).toHaveBeenCalledWith(scope, "a1", { name: "New" });
    });

    it("returns a rejected write as-is", async () => {
      vi.mocked(updateAgentRow).mockResolvedValueOnce({
        error: "Circular dependency detected",
      });

      expect(
        await callTool(tools.updateAgent, {
          agentId: "a1",
          label: "Agent",
          subAgentIds: ["a1"],
        }),
      ).toEqual({ error: "Circular dependency detected" });
    });
  });

  describe.each([
    {
      name: "updateAgent",
      service: updateAgentRow,
      call: (t: typeof tools) =>
        callTool(t.updateAgent, { agentId: "a1", label: "Agent", name: "X" }),
    },
    {
      name: "deleteAgent",
      service: deleteAgentRow,
      call: (t: typeof tools) =>
        callTool(t.deleteAgent, { agentId: "a1", label: "Agent" }),
    },
  ])("$name refusals", ({ service, call }) => {
    it.each([
      new NotFoundError("Agent not found"),
      new LockedError("This agent is managed at the organization level"),
    ])("reports $name to the model as an error result", async (error) => {
      vi.mocked(service).mockRejectedValueOnce(error);

      expect(await call(tools)).toEqual({ error: error.message });
    });

    it("lets any other failure throw", async () => {
      vi.mocked(service).mockRejectedValueOnce(new Error("connection lost"));

      await expect(call(tools)).rejects.toThrow("connection lost");
    });
  });

  describe("deleteAgent", () => {
    it("deletes at workspace scope", async () => {
      vi.mocked(deleteAgentRow).mockResolvedValueOnce();

      expect(
        await callTool(tools.deleteAgent, { agentId: "a1", label: "Agent" }),
      ).toEqual({ success: true });
      expect(deleteAgentRow).toHaveBeenCalledWith(scope, "a1");
    });
  });
});
