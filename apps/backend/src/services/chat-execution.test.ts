import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

const {
  mockCreateOpenAI,
  mockCreateOpenRouter,
  mockCreateAmazonBedrock,
  mockCreateGoogleGenerativeAI,
  mockCreateAnthropic,
} = vi.hoisted(() => {
  const makeMock = () => {
    const instance = vi.fn((modelId: string) => ({ modelId, _sentinel: true }));
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

// Also mock the dynamic import of schema used by fetchUserContexts
vi.mock("../db/schema.ts", async () => {
  const actual = await vi.importActual("../db/schema.ts");
  return actual;
});

import {
  createModel,
  resolveChatContext,
  loadSkills,
  fetchUserContexts,
} from "./chat-execution.ts";

const baseProvider = {
  id: "p1",
  name: "Test",
  organizationId: "org-1",
  workspaceId: "ws-1",
  providerType: "OpenAI" as const,
  modelIds: ["gpt-4"],
  apiKey: "sk-test",
  baseUrl: null,
  headers: null,
  organization: null,
  project: null,
  region: null,
  extraBody: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("chat-execution", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  describe("createModel", () => {
    it("calls createOpenAI with correct params", () => {
      createModel(baseProvider, "gpt-4");
      expect(mockCreateOpenAI.creator).toHaveBeenCalledWith({
        baseURL: undefined,
        apiKey: "sk-test",
        headers: undefined,
        organization: undefined,
        project: undefined,
      });
    });

    it("calls createOpenRouter for OpenRouter", () => {
      const provider = { ...baseProvider, providerType: "OpenRouter" as const };
      createModel(provider, "openai/gpt-4");
      expect(mockCreateOpenRouter.creator).toHaveBeenCalled();
    });

    it("calls createAmazonBedrock for Bedrock", () => {
      const provider = { ...baseProvider, providerType: "Bedrock" as const };
      createModel(provider, "anthropic.claude-v2");
      expect(mockCreateAmazonBedrock.creator).toHaveBeenCalled();
    });

    it("calls createGoogleGenerativeAI for Google", () => {
      const provider = { ...baseProvider, providerType: "Google" as const };
      createModel(provider, "gemini-pro");
      expect(mockCreateGoogleGenerativeAI.creator).toHaveBeenCalled();
    });

    it("calls createAnthropic for Anthropic", () => {
      const provider = { ...baseProvider, providerType: "Anthropic" as const };
      createModel(provider, "claude-3-opus-20240229");
      expect(mockCreateAnthropic.creator).toHaveBeenCalled();
    });

    it("throws for unknown provider type", () => {
      const provider = { ...baseProvider, providerType: "Unknown" as any };
      expect(() => createModel(provider, "some-model")).toThrow(
        "Unrecognized provider type 'Unknown'",
      );
    });

    it("passes undefined for null optional fields", () => {
      createModel(baseProvider, "gpt-4");
      expect(mockCreateOpenAI.creator).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: undefined,
          headers: undefined,
          organization: undefined,
          project: undefined,
        }),
      );
    });
  });

  describe("resolveChatContext", () => {
    const agentRecord = {
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

    const providerRecord = {
      ...baseProvider,
      modelIds: ["gpt-4"],
    };

    it("resolves context from agentId", async () => {
      mockDb.limit
        .mockResolvedValueOnce([agentRecord])
        .mockResolvedValueOnce([providerRecord]);

      const result = await resolveChatContext(
        { agentId: "agent-1" },
        "org-1",
        "ws-1",
      );

      expect(result.resolvedAgentId).toBe("agent-1");
      expect(result.resolvedModelId).toBe("gpt-4");
      expect(result.resolvedProviderId).toBe("p1");
      expect(result.resolvedMaxSteps).toBe(3);
      expect(result.agent).toEqual(agentRecord);
    });

    it("throws when agent not found", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(
        resolveChatContext({ agentId: "agent-missing" }, "org-1", "ws-1"),
      ).rejects.toThrow("Agent 'agent-missing' not found");
    });

    it("resolves from providerId+modelId (no agent)", async () => {
      mockDb.limit.mockResolvedValueOnce([providerRecord]);

      const result = await resolveChatContext(
        { providerId: "p1", modelId: "gpt-4" },
        "org-1",
        "ws-1",
      );

      expect(result.resolvedProviderId).toBe("p1");
      expect(result.resolvedModelId).toBe("gpt-4");
      expect(result.resolvedAgentId).toBeUndefined();
      expect(result.agent).toBeUndefined();
    });

    it("throws when neither agentId nor providerId+modelId", async () => {
      await expect(resolveChatContext({}, "org-1", "ws-1")).rejects.toThrow(
        "Must provide either agentId or (providerId and modelId)",
      );
    });

    it("throws when provider not found", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(
        resolveChatContext(
          { providerId: "p-missing", modelId: "gpt-4" },
          "org-1",
          "ws-1",
        ),
      ).rejects.toThrow("Provider with id 'p-missing' not found");
    });

    it("throws when modelId not in provider's modelIds", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { ...providerRecord, modelIds: ["gpt-3"] },
      ]);

      await expect(
        resolveChatContext(
          { providerId: "p1", modelId: "gpt-4" },
          "org-1",
          "ws-1",
        ),
      ).rejects.toThrow("Model id 'gpt-4' not enabled for provider 'p1'");
    });

    it("appends :online for OpenRouter when search=true", async () => {
      const openRouterProvider = {
        ...providerRecord,
        providerType: "OpenRouter" as const,
        modelIds: ["openai/gpt-4"],
      };
      mockDb.limit.mockResolvedValueOnce([openRouterProvider]);

      const result = await resolveChatContext(
        { providerId: "p1", modelId: "openai/gpt-4", search: true },
        "org-1",
        "ws-1",
      );

      expect(result.resolvedModelId).toBe("openai/gpt-4:online");
    });

    it("does not append :online for non-OpenRouter with search=true", async () => {
      mockDb.limit.mockResolvedValueOnce([providerRecord]);

      const result = await resolveChatContext(
        { providerId: "p1", modelId: "gpt-4", search: true },
        "org-1",
        "ws-1",
      );

      expect(result.resolvedModelId).toBe("gpt-4");
    });
  });

  describe("loadSkills", () => {
    it("returns empty array when agent undefined", async () => {
      const result = await loadSkills(undefined, "ws-1");
      expect(result).toEqual([]);
    });

    it("returns empty array when skillIds empty", async () => {
      const agent = { skillIds: [] } as any;
      const result = await loadSkills(agent, "ws-1");
      expect(result).toEqual([]);
    });

    it("returns skills from DB", async () => {
      const skillRecords = [
        { name: "Skill A", description: "Does A" },
        { name: "Skill B", description: "Does B" },
      ];
      mockDb.where.mockResolvedValueOnce(skillRecords);

      const agent = { skillIds: ["s1", "s2"] } as any;
      const result = await loadSkills(agent, "ws-1");

      expect(result).toEqual(skillRecords);
    });
  });

  describe("fetchUserContexts", () => {
    it("returns global and workspace contexts", async () => {
      const contexts = [
        { content: "global context", workspaceId: null },
        { content: "workspace context", workspaceId: "ws-1" },
      ];
      mockDb.where.mockResolvedValueOnce(contexts);

      const result = await fetchUserContexts("user-1", "ws-1");

      expect(result.userGlobalContext).toBe("global context");
      expect(result.userWorkspaceContext).toBe("workspace context");
    });

    it("returns undefined for both when no contexts", async () => {
      mockDb.where.mockResolvedValueOnce([]);

      const result = await fetchUserContexts("user-1", "ws-1");

      expect(result.userGlobalContext).toBeUndefined();
      expect(result.userWorkspaceContext).toBeUndefined();
    });

    it("ignores contexts for other workspaces", async () => {
      const contexts = [
        { content: "other workspace context", workspaceId: "ws-other" },
      ];
      mockDb.where.mockResolvedValueOnce(contexts);

      const result = await fetchUserContexts("user-1", "ws-1");

      expect(result.userGlobalContext).toBeUndefined();
      expect(result.userWorkspaceContext).toBeUndefined();
    });
  });
});
