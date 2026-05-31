import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const {
  mockCreateOpenAI,
  mockCreateOpenRouter,
  mockCreateAmazonBedrock,
  mockCreateGoogleGenerativeAI,
  mockCreateAnthropic,
} = vi.hoisted(() => {
  const makeMock = () => {
    const instance: any = vi.fn((modelId: string) => ({
      modelId,
      _sentinel: true,
    }));
    instance.chat = vi.fn((modelId: string) => ({
      modelId,
      _sentinel: true,
      _mode: "chat",
    }));
    const creator = vi.fn(() => instance);
    return { creator, instance };
  };
  const openai = makeMock();
  const openrouter = makeMock();
  const bedrock = makeMock();
  const google = makeMock();
  const anthropic = makeMock();
  return {
    mockCreateOpenAI: openai,
    mockCreateOpenRouter: openrouter,
    mockCreateAmazonBedrock: bedrock,
    mockCreateGoogleGenerativeAI: google,
    mockCreateAnthropic: anthropic,
  };
});

vi.mock("@ai-sdk/openai", () => ({ createOpenAI: mockCreateOpenAI.creator }));
vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: mockCreateOpenRouter.creator,
}));
vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: mockCreateAmazonBedrock.creator,
}));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: mockCreateGoogleGenerativeAI.creator,
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: mockCreateAnthropic.creator,
}));

const { mockCreateMCPClient } = vi.hoisted(() => ({
  mockCreateMCPClient: vi.fn(),
}));
vi.mock("@ai-sdk/mcp", () => ({
  experimental_createMCPClient: mockCreateMCPClient,
  auth: vi.fn(),
}));

import {
  prepareChatTurn,
  NotFoundError,
  ValidationError,
  createToolHeartbeat,
} from "./chat-execution.ts";
import { createInMemoryChatTurnQueries } from "./chat-execution.test-fixtures.ts";

const baseProvider = {
  id: "p1",
  name: "Test",
  organizationId: "org-1",
  workspaceId: "ws-1",
  providerType: "OpenAI" as const,
  modelIds: ["gpt-4"],
  apiKey: "sk-test",
  apiMode: "chat" as const,
  baseUrl: null,
  headers: null,
  organization: null,
  project: null,
  region: null,
  extraBody: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseAgent = {
  id: "agent-1",
  name: "Test Agent",
  workspaceId: "ws-1",
  providerId: "p1",
  modelId: "gpt-4",
  maxSteps: 3,
  systemPrompt: null,
  temperature: null,
  topP: null,
  topK: null,
  frequencyPenalty: null,
  presencePenalty: null,
  seed: null,
  toolSetIds: [],
  skillIds: [],
  subAgentIds: [],
  description: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseWorkspace = {
  id: "ws-1",
  organizationId: "org-1",
  ownerId: "user-1",
  name: "Test Workspace",
  context: null,
  taskModelProviderId: null,
  memoryExtractionProviderId: null,
  memoryEmbeddingProviderId: null,
  maxDailySummaries: 30,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseInput = {
  orgId: "org-1",
  workspaceId: "ws-1",
  user: { id: "user-1", name: "Test User" },
  messages: [],
  origin: "http://localhost:4000",
};

describe("chat-execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("prepareChatTurn", () => {
    it("Agent selection produces resolved IDs and a system prompt that surfaces the Agent's Skills", async () => {
      const agentWithSkill = { ...baseAgent, skillIds: ["skill-1"] };
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [agentWithSkill as any],
        providers: [baseProvider as any],
        skills: [
          {
            id: "skill-1",
            workspaceId: "ws-1",
            name: "kanban-flow",
            description: "Manage kanban boards",
          },
        ],
      });

      const turn = await prepareChatTurn(
        { ...baseInput, request: { id: "chat-1", agentId: agentWithSkill.id } },
        queries,
      );

      // resolved is what persistence will write
      expect(turn.resolved.agentId).toBe(agentWithSkill.id);
      expect(turn.resolved.providerId).toBe(baseProvider.id);
      expect(turn.resolved.modelId).toBe("gpt-4");
      // Agent-driven turn → row stores no copy of generation params
      expect(turn.resolved.systemPrompt).toBeUndefined();
      expect(turn.resolved.temperature).toBeUndefined();

      // stream is what streamText will consume
      expect(turn.stream.maxSteps).toBe(3);
      expect(turn.stream.system).toContain("kanban-flow");
      expect(turn.stream.system).toContain("Manage kanban boards");
      expect(turn.stream.tools).toHaveProperty("loadSkill");
      expect(turn.stream.messages).toEqual([]);

      // dispose is idempotent and does nothing without MCP clients
      await expect(turn.dispose()).resolves.toBeUndefined();
      await expect(turn.dispose()).resolves.toBeUndefined();
    });

    it("Direct Provider+Model selection populates resolved.systemPrompt and merges request overrides", async () => {
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        providers: [baseProvider as any],
      });

      const turn = await prepareChatTurn(
        {
          ...baseInput,
          request: {
            id: "chat-2",
            providerId: baseProvider.id,
            modelId: "gpt-4",
            systemPrompt: "Be terse.",
            temperature: 0.7,
          },
        },
        queries,
      );

      expect(turn.resolved.agentId).toBeUndefined();
      expect(turn.resolved.providerId).toBe(baseProvider.id);
      expect(turn.resolved.modelId).toBe("gpt-4");
      // Direct turn → resolved carries the params that will be written to the row
      expect(turn.resolved.systemPrompt).toBeDefined();
      expect(turn.resolved.systemPrompt).toContain("Be terse.");
      expect(turn.resolved.temperature).toBe(0.7);

      // stream config matches resolved on a Direct turn
      expect(turn.stream.system).toContain("Be terse.");
      expect(turn.stream.temperature).toBe(0.7);
      // Direct turns default maxSteps to 1
      expect(turn.stream.maxSteps).toBe(1);
    });

    it("throws ValidationError when neither agentId nor providerId+modelId is supplied", async () => {
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
      });

      await expect(
        prepareChatTurn(
          { ...baseInput, request: { id: "chat-3" } as any },
          queries,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("throws NotFoundError when the Agent does not exist", async () => {
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
      });

      await expect(
        prepareChatTurn(
          {
            ...baseInput,
            request: { id: "chat-4", agentId: "agent-missing" },
          },
          queries,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws NotFoundError when the Provider does not exist", async () => {
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
      });

      await expect(
        prepareChatTurn(
          {
            ...baseInput,
            request: {
              id: "chat-5",
              providerId: "p-missing",
              modelId: "gpt-4",
            },
          },
          queries,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws ValidationError when the model id is not enabled on the Provider", async () => {
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        providers: [{ ...baseProvider, modelIds: ["gpt-3.5"] } as any],
      });

      await expect(
        prepareChatTurn(
          {
            ...baseInput,
            request: {
              id: "chat-6",
              providerId: baseProvider.id,
              modelId: "gpt-4",
            },
          },
          queries,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("throws NotFoundError when the Workspace does not exist", async () => {
      const queries = createInMemoryChatTurnQueries({});

      await expect(
        prepareChatTurn(
          {
            ...baseInput,
            request: {
              id: "chat-7",
              providerId: baseProvider.id,
              modelId: "gpt-4",
            },
          },
          queries,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("MCP tool-set resolution", () => {
    const baseMcp = {
      id: "mcp-1",
      organizationId: null as string | null,
      workspaceId: null as string | null,
      name: "Test MCP",
      url: "https://mcp.example.com",
      headers: null,
      authType: "None",
      bearerToken: null,
      oauthAccessToken: null,
      oauthRefreshToken: null,
      oauthTokenExpiresAt: null,
      oauthScope: null,
      oauthRequestedScope: null,
      oauthClientId: null,
      oauthClientSecret: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const agentWithMcp = { ...baseAgent, toolSetIds: ["mcp-1"] };

    it("resolves an org-scoped (Shared) MCP at Chat-turn time", async () => {
      mockCreateMCPClient.mockResolvedValueOnce({
        tools: vi.fn().mockResolvedValue({ mcpTool: { description: "x" } }),
        close: vi.fn().mockResolvedValue(undefined),
      });

      // Org-scoped MCP: organizationId set, workspaceId null. The invoking
      // workspace (ws-1) references it via the agent's tool sets, and an
      // Attachment makes it visible there (ADR-0007 / #154).
      const orgMcp = { ...baseMcp, organizationId: "org-1" };
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [agentWithMcp as any],
        providers: [baseProvider as any],
        mcps: [orgMcp as any],
        attachments: [
          {
            workspaceId: baseWorkspace.id,
            resourceType: "mcp",
            resourceId: orgMcp.id,
          },
        ],
      });

      const turn = await prepareChatTurn(
        { ...baseInput, request: { id: "chat-mcp", agentId: agentWithMcp.id } },
        queries,
      );

      expect(turn.stream.tools).toHaveProperty("mcpTool");
      await turn.dispose();
    });

    it("skips an org-scoped MCP that is not attached to the workspace", async () => {
      // No MCP client is mocked: an unattached org-scoped MCP must never reach
      // the connection step. (Queueing an unconsumed mockResolvedValueOnce here
      // would leak into the next test, since vi.clearAllMocks keeps once-values.)

      // Org-scoped MCP with NO attachment to the invoking workspace → it must
      // not resolve, so its tools are absent (the tool-set id is unknown).
      const orgMcp = { ...baseMcp, organizationId: "org-1" };
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [agentWithMcp as any],
        providers: [baseProvider as any],
        mcps: [orgMcp as any],
        // no attachments
      });

      const turn = await prepareChatTurn(
        { ...baseInput, request: { id: "chat-mcp", agentId: agentWithMcp.id } },
        queries,
      );

      expect(turn.stream.tools).not.toHaveProperty("mcpTool");
      await turn.dispose();
    });

    it("fails soft when the MCP is unreachable — warns, adds no tools, does not throw", async () => {
      mockCreateMCPClient.mockRejectedValueOnce(
        new Error("ECONNREFUSED: connection refused"),
      );

      const orgMcp = { ...baseMcp, organizationId: "org-1" };
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [agentWithMcp as any],
        providers: [baseProvider as any],
        mcps: [orgMcp as any],
        attachments: [
          {
            workspaceId: baseWorkspace.id,
            resourceType: "mcp",
            resourceId: orgMcp.id,
          },
        ],
      });

      // The unreachable MCP must not kill the Chat turn.
      const turn = await prepareChatTurn(
        { ...baseInput, request: { id: "chat-mcp", agentId: agentWithMcp.id } },
        queries,
      );

      expect(turn.stream.tools).not.toHaveProperty("mcpTool");
      await turn.dispose();
    });
  });

  describe("createToolHeartbeat", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("fires bump at the configured cadence while a tool is in flight", () => {
      const bump = vi.fn();
      const hb = createToolHeartbeat(bump, 1000);

      hb.onToolStart();
      // No bump yet — the heartbeat fires on each interval tick, not at start.
      expect(bump).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(bump).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2000);
      expect(bump).toHaveBeenCalledTimes(3);

      hb.onToolEnd();
      vi.advanceTimersByTime(5000);
      // No further bumps after the last tool ends.
      expect(bump).toHaveBeenCalledTimes(3);
    });

    it("keeps a single heartbeat running across parallel tool calls", () => {
      const bump = vi.fn();
      const hb = createToolHeartbeat(bump, 1000);

      hb.onToolStart();
      hb.onToolStart();
      hb.onToolStart();
      expect(hb.inflight()).toBe(3);

      vi.advanceTimersByTime(3000);
      // Three ticks — proves only one interval is running, not three.
      expect(bump).toHaveBeenCalledTimes(3);

      hb.onToolEnd();
      hb.onToolEnd();
      // Still one tool in flight, heartbeat continues.
      vi.advanceTimersByTime(1000);
      expect(bump).toHaveBeenCalledTimes(4);

      hb.onToolEnd();
      expect(hb.inflight()).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(bump).toHaveBeenCalledTimes(4);
    });

    it("stop() halts the heartbeat and prevents future onToolStart from restarting it", () => {
      const bump = vi.fn();
      const hb = createToolHeartbeat(bump, 1000);

      hb.onToolStart();
      vi.advanceTimersByTime(1000);
      expect(bump).toHaveBeenCalledTimes(1);

      hb.stop();
      vi.advanceTimersByTime(5000);
      expect(bump).toHaveBeenCalledTimes(1);

      // Defensive: a tool callback firing after dispose must not resurrect
      // a heartbeat that nothing will clean up.
      hb.onToolStart();
      vi.advanceTimersByTime(5000);
      expect(bump).toHaveBeenCalledTimes(1);
    });

    it("onToolEnd is safe to over-call (inflight clamped at zero)", () => {
      const bump = vi.fn();
      const hb = createToolHeartbeat(bump, 1000);

      hb.onToolEnd();
      hb.onToolEnd();
      expect(hb.inflight()).toBe(0);

      vi.advanceTimersByTime(5000);
      expect(bump).not.toHaveBeenCalled();
    });
  });
});
