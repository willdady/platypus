import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";

type NativeSearchTool = Mock<() => { _nativeSearch: true }>;

type ProviderInstance = Mock<
  (modelId: string) => { modelId: string; _sentinel: boolean }
> & {
  chat: Mock<
    (modelId: string) => { modelId: string; _sentinel: boolean; _mode: string }
  >;
  // `openProvider`'s `searchTools()` reaches into the SDK's native tool
  // namespace. Stubbed here so the search-resolution tests can assert whether
  // native search was reached for at all — a Web-search backend taking
  // precedence means these are never called.
  tools: {
    webSearch: NativeSearchTool;
    webSearch_20250305: NativeSearchTool;
    googleSearch: NativeSearchTool;
  };
};

const {
  mockCreateOpenAI,
  mockCreateOpenRouter,
  mockCreateAmazonBedrock,
  mockCreateGoogleGenerativeAI,
  mockCreateAnthropic,
} = vi.hoisted(() => {
  const makeMock = () => {
    const instance = vi.fn((modelId: string) => ({
      modelId,
      _sentinel: true,
    })) as ProviderInstance;
    instance.chat = vi.fn((modelId: string) => ({
      modelId,
      _sentinel: true,
      _mode: "chat",
    }));
    const nativeSearchTool = (): NativeSearchTool =>
      vi.fn(() => ({ _nativeSearch: true as const }));
    instance.tools = {
      webSearch: nativeSearchTool(),
      webSearch_20250305: nativeSearchTool(),
      googleSearch: nativeSearchTool(),
    };
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
  validateTurnAttachments,
  resolveSearchMode,
  wrapToolsWithActivity,
  normalizeToolResult,
  type ToolActivityEvent,
} from "./chat-execution.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import {
  clearWebBackends,
  composeWebBackend,
  registerWebBackend,
  type WebBackendContribution,
} from "../web-backends/index.ts";
import { composeToolSet, registerToolSet } from "../tools/index.ts";
import { logger } from "../logger.ts";
import { FileValidationError } from "./file-gate.ts";
import { resetExtractedTextCache } from "./file-extraction.ts";
import { buildTestPdf } from "./file-extraction.test-fixtures.ts";
import { createInMemoryChatTurnQueries } from "./chat-execution.test-fixtures.ts";
import { formatSummariesForSystemPrompt } from "./memory-retrieval.ts";
import { DEFAULT_DIRECT_MAX_STEPS } from "@platypus/schemas";
import type { Provider } from "@platypus/schemas";
import type { PlatypusUIMessage } from "../types.ts";

const baseProvider = {
  id: "p1",
  name: "Test",
  organizationId: "org-1",
  workspaceId: "ws-1",
  providerType: "OpenAI" as const,
  modelIds: [{ id: "gpt-4", passthroughFileTypes: [] }],
  apiKey: "sk-test",
  apiMode: "chat" as const,
  searchSource: "native",
  taskModelId: "gpt-4",
  memoryExtractionModelId: "gpt-4",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseAgent = {
  id: "agent-1",
  name: "Test Agent",
  organizationId: null,
  workspaceId: "ws-1",
  providerId: "p1",
  modelId: "gpt-4",
  maxSteps: 3,
  instructions: null,
  temperature: null,
  topP: null,
  topK: null,
  frequencyPenalty: null,
  presencePenalty: null,
  seed: null,
  toolSetIds: [],
  skillIds: [],
  subAgentIds: [],
  description: "Test agent",
  inputPlaceholder: null,
  avatarKey: null,
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
  providerSelfManagement: false,
  mcpSelfManagement: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseInput = {
  orgId: "org-1",
  workspaceId: "ws-1",
  user: { id: "user-1", name: "Test User" },
  messages: [],
  origin: "http://localhost:4000",
  // Fixed, not `new Date()`: the retrieval window is an input, so a test that
  // does not care about it must still not vary by when it ran.
  memoriesReferenceDate: new Date("2026-05-03T12:00:00Z"),
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
        agents: [agentWithSkill],
        providers: [baseProvider],
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
        { ...baseInput, request: { agentId: agentWithSkill.id } },
        queries,
      );

      // resolved is what persistence will write
      expect(turn.resolved.agentId).toBe(agentWithSkill.id);
      expect(turn.resolved.providerId).toBe(baseProvider.id);
      expect(turn.resolved.modelId).toBe("gpt-4");
      // Agent-driven turn → row stores no copy of generation params
      expect(turn.resolved.instructions).toBeUndefined();
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

    it("keeps the system prompt byte-identical across turns that reuse a pinned Memories snapshot, regardless of live retrieval (ADR-0020)", async () => {
      const day = new Date();
      const memoryA = {
        id: "m1",
        userId: "user-1",
        workspaceId: "ws-1",
        summaryDate: "2026-04-29",
        summary: "Likes coffee.",
        embedding: null,
        createdAt: day,
        updatedAt: day,
      };
      const memoryB = { ...memoryA, summary: "Prefers tea." };

      // Two turn resolutions with the SAME pinned snapshot but DIFFERENT live
      // memory retrievals behind it: the retrieval varies per turn without
      // anyone doing anything, so the renderer must consume the pin, never it.
      const queriesLiveB = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [baseAgent],
        providers: [baseProvider],
        memories: [memoryB],
      });
      const queriesLiveA = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [baseAgent],
        providers: [baseProvider],
        memories: [memoryA],
      });

      const pinned = formatSummariesForSystemPrompt([memoryA]);

      const turnA = await prepareChatTurn(
        {
          ...baseInput,
          request: { agentId: baseAgent.id },
          memorySnapshot: pinned,
        },
        queriesLiveB,
      );
      const turnB = await prepareChatTurn(
        {
          ...baseInput,
          request: { agentId: baseAgent.id },
          memorySnapshot: pinned,
        },
        queriesLiveA,
      );

      // Identical bytes across turns, and the content is the PIN, not the live
      // retrieval whichever one preceded the call.
      expect(turnB.stream.system).toBe(turnA.stream.system);
      expect(turnA.stream.system).toContain("Likes coffee.");
      expect(turnA.stream.system).not.toContain("Prefers tea.");
      await turnA.dispose();
      await turnB.dispose();
    });

    it("(control) without a pin, differing live retrieval DOES change the prefix — the pin is what stabilises it", async () => {
      const day = new Date();
      const memoryA = {
        id: "m1",
        userId: "user-1",
        workspaceId: "ws-1",
        summaryDate: "2026-04-29",
        summary: "Likes coffee.",
        embedding: null,
        createdAt: day,
        updatedAt: day,
      };
      const memoryB = { ...memoryA, summary: "Prefers tea." };
      const queriesA = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [baseAgent],
        providers: [baseProvider],
        memories: [memoryA],
      });
      const queriesB = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [baseAgent],
        providers: [baseProvider],
        memories: [memoryB],
      });

      const turnA = await prepareChatTurn(
        { ...baseInput, request: { agentId: baseAgent.id } },
        queriesA,
      );
      const turnB = await prepareChatTurn(
        { ...baseInput, request: { agentId: baseAgent.id } },
        queriesB,
      );

      expect(turnB.stream.system).not.toBe(turnA.stream.system);
      await turnA.dispose();
      await turnB.dispose();
    });

    it("anchors a headless run's retrieval window to the caller's reference date, not a clock read (ADR-0020)", async () => {
      const referenceDate = new Date("2026-05-03T12:00:00Z");
      const seen: Date[] = [];
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [baseAgent],
        providers: [baseProvider],
      });
      const recording = {
        ...queries,
        getRecentMemories(userId: string, workspaceId: string, ref: Date) {
          seen.push(ref);
          return queries.getRecentMemories(userId, workspaceId, ref);
        },
      };

      // Two headless runs (no pin) given the SAME reference date. Turn
      // preparation reads no clock of its own, so the prefix cannot drift
      // between them — the midnight rollover a Trigger used to suffer.
      const turnA = await prepareChatTurn(
        {
          ...baseInput,
          request: { agentId: baseAgent.id },
          memoriesReferenceDate: referenceDate,
        },
        recording,
      );
      const turnB = await prepareChatTurn(
        {
          ...baseInput,
          request: { agentId: baseAgent.id },
          memoriesReferenceDate: referenceDate,
        },
        recording,
      );

      expect(turnB.stream.system).toBe(turnA.stream.system);
      // The window came from the input, verbatim — both times.
      expect(seen).toEqual([referenceDate, referenceDate]);
      await turnA.dispose();
      await turnB.dispose();
    });

    it("resolves an org-scoped (Shared) Skill referenced by the Agent only where attached", async () => {
      const agentWithSkill = { ...baseAgent, skillIds: ["org-skill-1"] };
      const orgSkill = {
        id: "org-skill-1",
        organizationId: "org-1",
        workspaceId: null,
        name: "shared-skill",
        description: "An organization-shared skill",
      };

      // Attached → the Skill surfaces in the system prompt.
      const attached = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [agentWithSkill],
        providers: [baseProvider],
        skills: [orgSkill],
        attachments: [
          {
            workspaceId: "ws-1",
            resourceType: "skill",
            resourceId: "org-skill-1",
          },
        ],
      });

      const attachedTurn = await prepareChatTurn(
        {
          ...baseInput,
          request: { agentId: agentWithSkill.id },
        },
        attached,
      );
      expect(attachedTurn.stream.system).toContain("shared-skill");
      expect(attachedTurn.stream.tools).toHaveProperty("loadSkill");

      // Not attached → the Skill is invisible to this workspace.
      const detached = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [agentWithSkill],
        providers: [baseProvider],
        skills: [orgSkill],
      });

      const detachedTurn = await prepareChatTurn(
        {
          ...baseInput,
          request: { agentId: agentWithSkill.id },
        },
        detached,
      );
      expect(detachedTurn.stream.system).not.toContain("shared-skill");
      expect(detachedTurn.stream.tools).not.toHaveProperty("loadSkill");
    });

    it("runs a Shared (org-scoped) Agent invoked from a borrowing Workspace where attached", async () => {
      const borrowingWorkspace = { ...baseWorkspace, id: "ws-2" };
      const orgProvider = {
        ...baseProvider,
        id: "p-org",
        organizationId: "org-1",
        workspaceId: undefined,
      };
      const sharedAgent = {
        ...baseAgent,
        id: "shared-agent",
        organizationId: "org-1",
        workspaceId: null,
        providerId: "p-org",
      };

      // Attached to the borrowing Workspace → the Shared Agent (and its
      // org-scoped Provider) resolve against that Workspace (ADR-0007).
      const attached = createInMemoryChatTurnQueries({
        workspaces: [borrowingWorkspace],
        agents: [sharedAgent],
        providers: [orgProvider],
        attachments: [
          {
            workspaceId: "ws-2",
            resourceType: "agent",
            resourceId: "shared-agent",
          },
          {
            workspaceId: "ws-2",
            resourceType: "provider",
            resourceId: "p-org",
          },
        ],
      });

      const turn = await prepareChatTurn(
        {
          ...baseInput,
          workspaceId: "ws-2",
          request: { agentId: "shared-agent" },
        },
        attached,
      );
      expect(turn.resolved.agentId).toBe("shared-agent");
      expect(turn.resolved.providerId).toBe("p-org");

      // Not attached → the Shared Agent is invisible to this Workspace.
      const detached = createInMemoryChatTurnQueries({
        workspaces: [borrowingWorkspace],
        agents: [sharedAgent],
        providers: [orgProvider],
      });
      await expect(
        prepareChatTurn(
          {
            ...baseInput,
            workspaceId: "ws-2",
            request: { agentId: "shared-agent" },
          },
          detached,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("resolves a sub-agent at the invoking Workspace's scope, or org-scoped where attached", async () => {
      const workspaceSubAgent = {
        ...baseAgent,
        id: "sub-ws",
        name: "Research Agent",
        description: "Looks things up.",
      };
      const orgSubAgent = {
        ...baseAgent,
        id: "sub-org",
        name: "Shared Agent",
        description: "Shared specialist.",
        organizationId: "org-1",
        workspaceId: null,
      };
      const parent = {
        ...baseAgent,
        subAgentIds: ["sub-ws", "sub-org"],
      };

      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [parent, workspaceSubAgent, orgSubAgent],
        providers: [baseProvider],
        attachments: [
          { workspaceId: "ws-1", resourceType: "agent", resourceId: "sub-org" },
        ],
      });

      const turn = await prepareChatTurn(
        { ...baseInput, request: { agentId: parent.id } },
        queries,
      );

      // One delegation tool for both sub-agents; the prompt's catalogue is
      // what tells them apart.
      expect(turn.stream.tools).toHaveProperty("delegate");
      expect(turn.stream.system).toContain("Research Agent");
      expect(turn.stream.system).toContain("Shared Agent");
      expect(turn.stream.system).not.toContain("## Unavailable Sub-Agents");
    });

    // A parent with MCP-backed delegates used to connect to — and warn about —
    // every one of their servers on every turn, delegation or not. The delegate
    // now opens its own session when it is first invoked.
    it("opens no connections for a delegate the turn never invokes", async () => {
      const subAgent = {
        ...baseAgent,
        id: "sub-mcp",
        name: "Research Agent",
        toolSetIds: ["mcp-1"],
      };
      const parent = { ...baseAgent, subAgentIds: ["sub-mcp"] };

      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [parent, subAgent],
        providers: [baseProvider],
        mcps: [
          {
            id: "mcp-1",
            workspaceId: "ws-1",
            url: "https://mcp.example.com",
            authType: "None",
          } as never,
        ],
      });
      const getMcp = vi.spyOn(queries, "getMcp");

      const turn = await prepareChatTurn(
        { ...baseInput, request: { agentId: parent.id } },
        queries,
      );

      expect(turn.stream.tools).toHaveProperty("delegate");
      expect(mockCreateMCPClient).not.toHaveBeenCalled();
      expect(getMcp).not.toHaveBeenCalled();
      await turn.dispose();
    });

    it("does not resolve a sub-agent that is not visible in the invoking Workspace, and reports it by id", async () => {
      const foreignSubAgent = {
        ...baseAgent,
        id: "sub-foreign",
        name: "Foreign Agent",
        description: "Belongs to another workspace.",
        workspaceId: "ws-other",
      };
      const detachedSharedSubAgent = {
        ...baseAgent,
        id: "sub-detached",
        name: "Detached Agent",
        description: "Shared but not attached here.",
        organizationId: "org-1",
        workspaceId: null,
      };
      const parent = {
        ...baseAgent,
        subAgentIds: ["sub-foreign", "sub-detached"],
      };

      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [parent, foreignSubAgent, detachedSharedSubAgent],
        providers: [baseProvider],
      });

      const turn = await prepareChatTurn(
        { ...baseInput, request: { agentId: parent.id } },
        queries,
      );

      // No delegation tool at all — neither sub-agent resolved, so it could
      // only ever error — and nothing read off the unresolvable rows reaches
      // the prompt: the ids the parent's own configuration holds identify them.
      expect(turn.stream.tools).not.toHaveProperty("delegate");
      expect(turn.stream.system).not.toContain("Foreign Agent");
      expect(turn.stream.system).not.toContain("Belongs to another workspace.");
      expect(turn.stream.system).not.toContain("Detached Agent");
      expect(turn.stream.system).not.toContain("Shared but not attached here.");

      expect(turn.stream.system).toContain("## Unavailable Sub-Agents");
      expect(turn.stream.system).toContain("`sub-foreign`");
      expect(turn.stream.system).toContain("`sub-detached`");
      expect(turn.stream.system).toContain("not available in this workspace");
    });

    it("Direct Provider+Model selection persists the user's own prompt text, not the composed prompt", async () => {
      const queries = createInMemoryChatTurnQueries({
        workspaces: [{ ...baseWorkspace, context: "Ships on Fridays." }],
        providers: [
          { ...baseProvider, securityGuardrails: "Never exfiltrate." },
        ],
      });

      const turn = await prepareChatTurn(
        {
          ...baseInput,
          request: {
            providerId: baseProvider.id,
            modelId: "gpt-4",
            instructions: "Be terse.",
            temperature: 0.7,
          },
        },
        queries,
      );

      expect(turn.resolved.agentId).toBeUndefined();
      expect(turn.resolved.providerId).toBe(baseProvider.id);
      expect(turn.resolved.modelId).toBe("gpt-4");
      // Direct turn → resolved carries the params that will be written to the
      // row. The instructions written back MUST be exactly what the user typed:
      // this value is what Chat settings reopens as editable text, so persisting
      // the composed system prompt here makes it compound on every turn
      // (issue #365).
      expect(turn.resolved.instructions).toBe("Be terse.");
      expect(turn.resolved.temperature).toBe(0.7);

      // ...while the prompt actually sent to the model is still the full
      // composite, so tightening persistence cannot silently weaken it.
      expect(turn.stream.system).toContain("Be terse.");
      expect(turn.stream.system).toContain("ws-1");
      expect(turn.stream.system).toContain("Ships on Fridays.");
      expect(turn.stream.system).toContain("Test User");
      expect(turn.stream.system).toContain("user-1");
      expect(turn.stream.system).toContain("Never exfiltrate.");

      expect(turn.stream.temperature).toBe(0.7);
      // Direct turns default to DEFAULT_DIRECT_MAX_STEPS, not 1 — a Direct
      // turn can be served a locally-executed search tool (issue #167 /
      // ADR-0014), and the model needs a further step to answer from its
      // result (issue #463).
      expect(turn.stream.maxSteps).toBe(DEFAULT_DIRECT_MAX_STEPS);
    });

    // `seed` used to be read straight off the request while the other five came
    // from `agent || data`, so an Agent's stored Seed never reached the model.
    it("sends the Agent's own seed, not the request's, on an Agent turn", async () => {
      const seededAgent = { ...baseAgent, seed: 1234, temperature: 0.4 };
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [seededAgent],
        providers: [baseProvider],
      });

      const turn = await prepareChatTurn(
        { ...baseInput, request: { agentId: seededAgent.id } },
        queries,
      );

      expect(turn.stream.seed).toBe(1234);
      expect(turn.stream.temperature).toBe(0.4);
      // Agent-driven turns still don't persist generation params on the row.
      expect(turn.resolved.seed).toBeUndefined();
    });

    it("still takes seed from the request on a Direct turn", async () => {
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        providers: [baseProvider],
      });

      const turn = await prepareChatTurn(
        {
          ...baseInput,
          request: { providerId: baseProvider.id, modelId: "gpt-4", seed: 99 },
        },
        queries,
      );

      expect(turn.stream.seed).toBe(99);
      expect(turn.resolved.seed).toBe(99);
    });

    // Issue #539: the per-chat Max steps setting rides the turn request and,
    // on a Direct turn, becomes both the ceiling the model loop runs under
    // and the value persisted back to the row — the same round-trip as seed
    // above.
    it("takes maxSteps from the request on a Direct turn", async () => {
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        providers: [baseProvider],
      });

      const turn = await prepareChatTurn(
        {
          ...baseInput,
          request: {
            providerId: baseProvider.id,
            modelId: "gpt-4",
            maxSteps: 25,
          },
        },
        queries,
      );

      expect(turn.stream.maxSteps).toBe(25);
      expect(turn.resolved.maxSteps).toBe(25);
    });

    // The #263 shape at this seam: a null arriving from a client that clears
    // by sending one must leave the row's copy unset rather than persisting
    // the default over it — otherwise "unset" and "explicitly 10" become
    // indistinguishable after one turn.
    it("treats a cleared per-chat maxSteps as unset on a Direct turn", async () => {
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        providers: [baseProvider],
      });

      const turn = await prepareChatTurn(
        {
          ...baseInput,
          request: {
            providerId: baseProvider.id,
            modelId: "gpt-4",
            maxSteps: null,
          },
        },
        queries,
      );

      expect(turn.stream.maxSteps).toBe(DEFAULT_DIRECT_MAX_STEPS);
      expect(turn.resolved.maxSteps).toBeUndefined();
    });

    // Mirrors the seed test above: an Agent's stored settings win on an
    // Agent-backed Chat, and the row keeps no generation params of its own.
    it("sends the Agent's own maxSteps, not the request's, on an Agent turn", async () => {
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [baseAgent],
        providers: [baseProvider],
      });

      const turn = await prepareChatTurn(
        {
          ...baseInput,
          request: { agentId: baseAgent.id, maxSteps: 25 },
        },
        queries,
      );

      expect(turn.stream.maxSteps).toBe(3);
      expect(turn.resolved.maxSteps).toBeUndefined();
    });

    // The output ceiling comes off the PROVIDER's model entry, not the Agent or
    // the request — it is a property of the (Provider, model) pair (issue #454).
    it("streams the model's declared maxOutputTokens", async () => {
      const cappedProvider = {
        ...baseProvider,
        modelIds: [
          { id: "gpt-4", passthroughFileTypes: [], maxOutputTokens: 64000 },
        ],
      };
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [baseAgent],
        providers: [cappedProvider],
      });

      const turn = await prepareChatTurn(
        { ...baseInput, request: { agentId: baseAgent.id } },
        queries,
      );

      expect(turn.stream.maxOutputTokens).toBe(64000);
    });

    // Undeclared must stay undefined all the way to the SDK: any default of
    // ours would change generation for every existing Provider.
    it("leaves maxOutputTokens undefined when the model declares none", async () => {
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        providers: [baseProvider],
      });

      const turn = await prepareChatTurn(
        {
          ...baseInput,
          request: { providerId: baseProvider.id, modelId: "gpt-4" },
        },
        queries,
      );

      expect(turn.stream.maxOutputTokens).toBeUndefined();
    });

    // An alias reference resolves to the entry, so the ceiling follows a
    // repoint rather than being looked up by the stored string.
    it("takes maxOutputTokens from the entry an alias reference resolves to", async () => {
      const aliasProvider = {
        ...baseProvider,
        modelIds: [
          {
            id: "gpt-4",
            alias: "flagship",
            passthroughFileTypes: [],
            maxOutputTokens: 32000,
          },
        ],
      };
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [{ ...baseAgent, modelId: "alias:flagship" }],
        providers: [aliasProvider],
      });

      const turn = await prepareChatTurn(
        { ...baseInput, request: { agentId: baseAgent.id } },
        queries,
      );

      expect(turn.stream.maxOutputTokens).toBe(32000);
    });

    // ADR-0018 Notes / issue #524: Tool-result clearing's only reading for the
    // first model call of a turn — read from the INCOMING history, before
    // this turn appends anything.
    describe("initialOccupancy", () => {
      it("is absent on a Chat's first turn (no prior assistant message)", async () => {
        const queries = createInMemoryChatTurnQueries({
          workspaces: [baseWorkspace],
          providers: [baseProvider],
        });

        const turn = await prepareChatTurn(
          {
            ...baseInput,
            request: { providerId: baseProvider.id, modelId: "gpt-4" },
          },
          queries,
        );

        expect(turn.stream).not.toHaveProperty("initialOccupancy");
      });

      it("sums the last assistant message's input and output tokens", async () => {
        const queries = createInMemoryChatTurnQueries({
          workspaces: [baseWorkspace],
          providers: [baseProvider],
        });

        const turn = await prepareChatTurn(
          {
            ...baseInput,
            messages: [
              {
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "hi" }],
              },
              {
                id: "m2",
                role: "assistant",
                parts: [{ type: "text", text: "hello" }],
                metadata: {
                  contextOccupancy: { inputTokens: 1000, outputTokens: 200 },
                },
              },
            ] as PlatypusUIMessage[],
            request: { providerId: baseProvider.id, modelId: "gpt-4" },
          },
          queries,
        );

        expect(turn.stream.initialOccupancy).toBe(1200);
      });

      it("reads the LAST assistant message's reading, not an earlier one", async () => {
        const queries = createInMemoryChatTurnQueries({
          workspaces: [baseWorkspace],
          providers: [baseProvider],
        });

        const turn = await prepareChatTurn(
          {
            ...baseInput,
            messages: [
              {
                id: "m1",
                role: "assistant",
                parts: [{ type: "text", text: "first" }],
                metadata: {
                  contextOccupancy: { inputTokens: 100, outputTokens: 10 },
                },
              },
              {
                id: "m2",
                role: "assistant",
                parts: [{ type: "text", text: "second" }],
                metadata: {
                  contextOccupancy: { inputTokens: 5000, outputTokens: 50 },
                },
              },
            ] as PlatypusUIMessage[],
            request: { providerId: baseProvider.id, modelId: "gpt-4" },
          },
          queries,
        );

        expect(turn.stream.initialOccupancy).toBe(5050);
      });

      it("treats a null (erased, stale) reading as unknown, same as absent", async () => {
        const queries = createInMemoryChatTurnQueries({
          workspaces: [baseWorkspace],
          providers: [baseProvider],
        });

        const turn = await prepareChatTurn(
          {
            ...baseInput,
            messages: [
              {
                id: "m1",
                role: "assistant",
                parts: [{ type: "text", text: "stale" }],
                metadata: {
                  contextOccupancy: { inputTokens: 100, outputTokens: 10 },
                },
              },
              {
                id: "m2",
                role: "assistant",
                parts: [{ type: "text", text: "erased" }],
                metadata: { contextOccupancy: null },
              },
            ] as PlatypusUIMessage[],
            request: { providerId: baseProvider.id, modelId: "gpt-4" },
          },
          queries,
        );

        expect(turn.stream).not.toHaveProperty("initialOccupancy");
      });
    });

    it("Agent without an explicit maxSteps falls back to the default (15), not 1", async () => {
      const agentNoMaxSteps = { ...baseAgent, maxSteps: null };
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [agentNoMaxSteps],
        providers: [baseProvider],
      });

      const turn = await prepareChatTurn(
        { ...baseInput, request: { agentId: agentNoMaxSteps.id } },
        queries,
      );

      expect(turn.stream.maxSteps).toBe(15);
    });

    it("throws ValidationError when neither agentId nor providerId+modelId is supplied", async () => {
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
      });

      await expect(
        prepareChatTurn({ ...baseInput, request: {} }, queries),
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
            request: { agentId: "agent-missing" },
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
        providers: [
          {
            ...baseProvider,
            modelIds: [{ id: "gpt-3.5", passthroughFileTypes: [] }],
          },
        ],
      });

      await expect(
        prepareChatTurn(
          {
            ...baseInput,
            request: {
              providerId: baseProvider.id,
              modelId: "gpt-4",
            },
          },
          queries,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    // --- Model aliases (issue #386, ADR-0017) ---

    describe("model aliases", () => {
      const aliasedProvider = {
        ...baseProvider,
        modelIds: [
          { id: "gpt-4", passthroughFileTypes: [], alias: "flagship" },
          { id: "gpt-3.5", passthroughFileTypes: [] },
        ],
      };

      it("runs a Chat turn against the model an alias reference points at", async () => {
        const queries = createInMemoryChatTurnQueries({
          workspaces: [baseWorkspace],
          providers: [aliasedProvider],
        });

        const turn = await prepareChatTurn(
          {
            ...baseInput,
            request: {
              providerId: aliasedProvider.id,
              modelId: "alias:flagship",
            },
          },
          queries,
        );

        expect(turn.stream.model).toMatchObject({ modelId: "gpt-4" });
      });

      it("persists the reference, not the resolution, so a repoint reaches the Chat", async () => {
        const queries = createInMemoryChatTurnQueries({
          workspaces: [baseWorkspace],
          providers: [aliasedProvider],
        });

        const turn = await prepareChatTurn(
          {
            ...baseInput,
            request: {
              providerId: aliasedProvider.id,
              modelId: "alias:flagship",
            },
          },
          queries,
        );

        // Storing "gpt-4" here would pin the Chat to today's model.
        expect(turn.resolved.modelId).toBe("alias:flagship");
      });

      it("resolves an Agent whose stored modelId is an alias reference", async () => {
        const queries = createInMemoryChatTurnQueries({
          workspaces: [baseWorkspace],
          agents: [{ ...baseAgent, modelId: "alias:flagship" }],
          providers: [aliasedProvider],
        });

        const turn = await prepareChatTurn(
          { ...baseInput, request: { agentId: baseAgent.id } },
          queries,
        );

        expect(turn.stream.model).toMatchObject({ modelId: "gpt-4" });
      });

      it("follows a repointed alias on the very next turn, with no edit to the Agent", async () => {
        const agent = { ...baseAgent, modelId: "alias:flagship" };
        const repointed = {
          ...baseProvider,
          modelIds: [
            { id: "gpt-4", passthroughFileTypes: [] },
            { id: "gpt-3.5", passthroughFileTypes: [], alias: "flagship" },
          ],
        };
        const queries = createInMemoryChatTurnQueries({
          workspaces: [baseWorkspace],
          agents: [agent],
          providers: [repointed],
        });

        const turn = await prepareChatTurn(
          { ...baseInput, request: { agentId: agent.id } },
          queries,
        );

        expect(turn.stream.model).toMatchObject({ modelId: "gpt-3.5" });
      });

      it("keeps resolving a bare id once its entry gains an alias — no migration", async () => {
        const queries = createInMemoryChatTurnQueries({
          workspaces: [baseWorkspace],
          agents: [{ ...baseAgent, modelId: "gpt-4" }],
          providers: [aliasedProvider],
        });

        const turn = await prepareChatTurn(
          { ...baseInput, request: { agentId: baseAgent.id } },
          queries,
        );

        expect(turn.stream.model).toMatchObject({ modelId: "gpt-4" });
      });

      it("fails the turn naming the alias and the Provider, with no fallback", async () => {
        const queries = createInMemoryChatTurnQueries({
          workspaces: [baseWorkspace],
          providers: [aliasedProvider],
        });

        await expect(
          prepareChatTurn(
            {
              ...baseInput,
              request: {
                providerId: aliasedProvider.id,
                modelId: "alias:ghost",
              },
            },
            queries,
          ),
        ).rejects.toThrow(
          new RegExp(`alias 'ghost'.*${aliasedProvider.id}`, "i"),
        );
      });

      it("uses the aliased model's own passthrough types, not the provider default", async () => {
        const queries = createInMemoryChatTurnQueries({
          workspaces: [baseWorkspace],
          providers: [
            {
              ...baseProvider,
              providerType: "OpenRouter" as const,
              modelIds: [
                {
                  id: "qwen-vl",
                  passthroughFileTypes: ["image/*"],
                  alias: "vision",
                },
              ],
            },
          ],
        });

        // A declared image/* survives resolution through the alias; the
        // OpenRouter default would have been [] and rejected the image.
        await expect(
          validateTurnAttachments(
            {
              messages: [
                {
                  id: "m1",
                  role: "user",
                  parts: [
                    {
                      type: "file",
                      mediaType: "image/png",
                      url: "storage://x.png",
                    },
                  ],
                },
              ],
              request: { providerId: baseProvider.id, modelId: "alias:vision" },
              orgId: "org-1",
              workspaceId: "ws-1",
            },
            queries,
          ),
        ).resolves.toBeUndefined();
      });
    });

    it("throws NotFoundError when the Workspace does not exist", async () => {
      const queries = createInMemoryChatTurnQueries({});

      await expect(
        prepareChatTurn(
          {
            ...baseInput,
            request: {
              providerId: baseProvider.id,
              modelId: "gpt-4",
            },
          },
          queries,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    // ADR-0014: a configured Web-search backend serves search *instead of* the
    // provider's native tool, and gates on the stored id alone — a stale id
    // degrades here rather than in the form.
    describe("search resolution", () => {
      // Google, not the OpenAI baseProvider: its native tool is named
      // `google_search`, so a natively-served turn is distinguishable from a
      // backend-served one by tool name alone.
      const googleProvider = {
        ...baseProvider,
        providerType: "Google" as const,
        apiMode: "responses" as const,
      };
      const googleSearchTool = () =>
        mockCreateGoogleGenerativeAI.instance.tools.googleSearch;

      // `overrides` reaches the contribution itself so a test can register the
      // misbehaving backends this suite needs — a factory that throws, one that
      // never settles, one that returns no `web_search` — without a second
      // helper. Omitted, it registers a healthy search-only backend.
      const register = (
        backend: string,
        executors: {
          web_search?: () => { query: string; results: [] };
          read_url?: () => { content: string; url: string };
        } = {},
        overrides: Partial<WebBackendContribution> = {},
      ) =>
        registerWebBackend(
          composeWebBackend({
            contribution: {
              backend,
              name: "SearXNG",
              createExecutors: () => ({
                web_search: () => ({ query: "q", results: [] }),
                ...executors,
              }),
              ...overrides,
            },
            pluginName: "@acme/searx",
          }),
        );

      // Typed as `Provider`, not `typeof googleProvider`: the fixtures set
      // `searchSource` to `"native"`, so a `typeof` parameter would reject
      // `{ ...provider, searchSource: "searx" }` as re-assigning a literal
      // type and force a cast at every call.
      const turnFor = (
        provider: Provider,
        search: boolean | undefined = true,
        runMode: "interactive" | "headless" = "interactive",
      ) =>
        prepareChatTurn(
          {
            ...baseInput,
            runMode,
            request: { providerId: provider.id, modelId: "gpt-4", search },
          },
          createInMemoryChatTurnQueries({
            workspaces: [baseWorkspace],
            providers: [provider],
          }),
        );

      beforeEach(() => {
        clearWebBackends();
      });
      afterEach(() => {
        clearWebBackends();
      });

      it("serves the provider's native tool when no web backend is set", async () => {
        const turn = await turnFor(googleProvider);

        expect(turn.stream.tools).toHaveProperty("google_search");
        expect(turn.stream.tools).not.toHaveProperty("read_url");
      });

      it("serves the web backend instead of native search when one is set", async () => {
        register("searx", { read_url: () => ({ content: "", url: "" }) });

        const turn = await turnFor({
          ...googleProvider,
          searchSource: "searx",
        });

        // Explicit plugin first: core's two Tools, and the native tool neither
        // injected nor even constructed.
        expect(turn.stream.tools).toHaveProperty("web_search");
        expect(turn.stream.tools).toHaveProperty("read_url");
        expect(turn.stream.tools).not.toHaveProperty("google_search");
        expect(googleSearchTool()).not.toHaveBeenCalled();
      });

      // Issue #463: a backend-served (locally-executed) search tool needs a
      // second step for the model to read its result and reply — a Direct
      // turn's ceiling must leave room for that, unlike the 1-step ceiling it
      // used to get.
      it("gives a Direct turn serving a backend search tool room to answer from it", async () => {
        register("searx", { read_url: () => ({ content: "", url: "" }) });

        const turn = await turnFor({
          ...googleProvider,
          searchSource: "searx",
        });

        expect(turn.stream.tools).toHaveProperty("web_search");
        expect(turn.stream.maxSteps).toBe(DEFAULT_DIRECT_MAX_STEPS);
        expect(turn.stream.maxSteps).toBeGreaterThan(1);
      });

      it("serves search only, when the backend contributes no read_url", async () => {
        register("searx");

        const turn = await turnFor({
          ...googleProvider,
          searchSource: "searx",
        });

        expect(turn.stream.tools).toHaveProperty("web_search");
        expect(turn.stream.tools).not.toHaveProperty("read_url");
      });

      it("serves no search tools, and warns, when the stored backend is no longer registered", async () => {
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

        // Nothing registered: the plugin that contributed `searx` was removed
        // from PLATYPUS_PLUGINS after an Operator selected it.
        const turn = await turnFor({
          ...googleProvider,
          searchSource: "searx",
        });

        expect(turn.stream.tools).not.toHaveProperty("web_search");
        expect(turn.stream.tools).not.toHaveProperty("read_url");
        // Never silently falls back to native — that would serve a different
        // search than the one the Operator chose.
        expect(turn.stream.tools).not.toHaveProperty("google_search");
        expect(googleSearchTool()).not.toHaveBeenCalled();
        // `providerId` is the field the remedy needs: an org-scoped Shared
        // Provider (ADR-0007) is one row serving many Workspaces, so
        // `workspaceId` alone names a symptom and not the row to edit.
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            orgId: "org-1",
            workspaceId: "ws-1",
            providerId: googleProvider.id,
            searchSource: "searx",
          }),
          expect.stringContaining("unregistered web backend"),
        );
        warn.mockRestore();
      });

      it("gives an OpenAI-compatible chat endpoint search it can honour, not the dead native tool", async () => {
        register("searx");

        // vLLM and friends: `openProvider` exposes `searchTools()` for every
        // OpenAI provider, but the Responses-API search tool is dead weight on a
        // chat-completions endpoint. `baseProvider` is exactly this shape.
        const turn = await turnFor({ ...baseProvider, searchSource: "searx" });

        expect(turn.stream.tools).toHaveProperty("web_search");
        expect(
          mockCreateOpenAI.instance.tools.webSearch,
        ).not.toHaveBeenCalled();
      });

      it("serves nothing when the request did not ask for search", async () => {
        register("searx", { read_url: () => ({ content: "", url: "" }) });

        const turn = await turnFor(
          { ...googleProvider, searchSource: "searx" },
          false,
        );

        expect(turn.stream.tools).not.toHaveProperty("web_search");
        expect(turn.stream.tools).not.toHaveProperty("read_url");
      });

      it("closes what a backend registered, once, through the dispose the turn returns", async () => {
        // The wiring test for the whole path: the registrar the search branch is
        // handed defers onto a session promise the `Promise.all` is still
        // awaiting, so this fails if that deferral is ever "simplified" into a
        // session the search branch does not have yet.
        const close = vi.fn().mockResolvedValue(undefined);
        registerWebBackend(
          composeWebBackend({
            contribution: {
              backend: "searx",
              name: "SearXNG",
              createExecutors: (ctx) => {
                ctx.registerCloser?.(close);
                return { web_search: () => ({ query: "q", results: [] }) };
              },
            },
            pluginName: "@acme/searx",
          }),
        );

        const turn = await turnFor({
          ...googleProvider,
          searchSource: "searx",
        });
        expect(turn.stream.tools).toHaveProperty("web_search");
        expect(close).not.toHaveBeenCalled();

        await turn.dispose();
        expect(close).toHaveBeenCalledTimes(1);

        // The caller disposes on abort and again on finish.
        await turn.dispose();
        expect(close).toHaveBeenCalledTimes(1);
      });

      it("serves a backend on a trigger-initiated run, not only an interactive one", async () => {
        // G16: a non-user principal reaches `prepareChatTurn` through
        // `AgentRunner` with `runMode: "headless"`, and resolution must not be
        // gated on the mode — there is one injection site for every run path.
        register("searx", { read_url: () => ({ content: "", url: "" }) });

        const turn = await turnFor(
          { ...googleProvider, searchSource: "searx" },
          true,
          "headless",
        );

        expect(turn.stream.tools).toHaveProperty("web_search");
        expect(turn.stream.tools).toHaveProperty("read_url");
        expect(googleSearchTool()).not.toHaveBeenCalled();
      });

      /**
       * Issue #522: search was asked for, resolution had somewhere to send it,
       * and no tools came back. The turn still runs — the model is never told —
       * so the flag is the only record the person reading the reply gets.
       *
       * Asserted on the outcome, not on a branch per cause: one condition
       * covers a stale backend id, a factory that threw or hung, a malformed
       * executor object, and whatever cause is added after them.
       */
      describe("reporting a turn that served no search", () => {
        const searxProvider = { ...googleProvider, searchSource: "searx" };

        // Silenced for the whole block: most of these cases warn by design.
        // Restored in `afterEach` rather than at the end of each test body,
        // which would leak the spy into the rest of the file the moment an
        // assertion above it fails. Scoped here, so the file's other spies are
        // untouched.
        beforeEach(() => {
          vi.spyOn(logger, "warn").mockImplementation(() => {});
        });
        afterEach(() => {
          vi.restoreAllMocks();
        });

        it("flags a stored backend id that is no longer registered", async () => {
          const turn = await turnFor(searxProvider);

          expect(turn.searchUnavailable).toBe(true);
        });

        it("flags a backend whose createExecutors throws", async () => {
          register(
            "searx",
            {},
            {
              createExecutors: () => {
                throw new Error("no credentials configured");
              },
            },
          );

          const turn = await turnFor(searxProvider);

          expect(turn.stream.tools).not.toHaveProperty("web_search");
          expect(turn.searchUnavailable).toBe(true);
        });

        // Issue #522's last criterion: all three warns name the Provider row,
        // which is the field an Operator edits. `providerId` reaches the two
        // raised inside `buildTurnTools` on core's own context, so the
        // plugin-facing `WebBackendContext` stays as ADR-0014 fixes it.
        it("names the Provider row on the warn from a factory that threw", async () => {
          const warn = vi.mocked(logger.warn);
          register(
            "searx",
            {},
            {
              createExecutors: () => {
                throw new Error("no credentials configured");
              },
            },
          );

          await turnFor(searxProvider);

          expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
              providerId: searxProvider.id,
              orgId: "org-1",
              workspaceId: "ws-1",
            }),
            expect.stringContaining("createExecutors threw"),
          );
        });

        it("names the Provider row on the warn from a missing web_search executor", async () => {
          const warn = vi.mocked(logger.warn);
          register(
            "searx",
            {},
            {
              createExecutors: () =>
                ({}) as unknown as ReturnType<
                  WebBackendContribution["createExecutors"]
                >,
            },
          );

          await turnFor(searxProvider);

          expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
              providerId: searxProvider.id,
              orgId: "org-1",
              workspaceId: "ws-1",
            }),
            expect.stringContaining("no web_search executor"),
          );
        });

        it("flags a backend whose createExecutors outruns its timeout", async () => {
          register(
            "searx",
            {},
            {
              // A factory that never settles, against a timeout short enough
              // for a test to wait out — the same shape the web-backend suite
              // uses to prove a backend cannot pin a turn open.
              timeoutMs: 20,
              createExecutors: () => new Promise(() => {}),
            },
          );

          const turn = await turnFor(searxProvider);

          expect(turn.stream.tools).not.toHaveProperty("web_search");
          expect(turn.searchUnavailable).toBe(true);
        });

        it("flags a backend that returns no web_search executor", async () => {
          register(
            "searx",
            {},
            {
              // A third-party JS plugin is under no obligation to honour the
              // SDK's types, so core narrows at runtime and this is what the
              // turn is left with.
              createExecutors: () =>
                ({}) as unknown as ReturnType<
                  WebBackendContribution["createExecutors"]
                >,
            },
          );

          const turn = await turnFor(searxProvider);

          expect(turn.stream.tools).not.toHaveProperty("web_search");
          expect(turn.searchUnavailable).toBe(true);
        });

        it("says nothing when the backend served its tools", async () => {
          register("searx", { read_url: () => ({ content: "", url: "" }) });

          const turn = await turnFor(searxProvider);

          expect(turn.searchUnavailable).toBe(false);
        });

        it("says nothing when the Provider's own native tool served the turn", async () => {
          const turn = await turnFor(googleProvider);

          expect(turn.stream.tools).toHaveProperty("google_search");
          expect(turn.searchUnavailable).toBe(false);
        });

        it("says nothing when the request never asked for search, stale id or not", async () => {
          // Nothing registered, so the id is as stale as in the first case —
          // but nothing was promised, so there is nothing to report.
          const turn = await turnFor(searxProvider, false);

          expect(turn.searchUnavailable).toBe(false);
        });

        it("says nothing when the Provider's searchSource resolves to no search", async () => {
          // `baseProvider` is the stale-native row: `searchSource: "native"` on
          // an OpenAI chat endpoint, which has no native tool. Resolution says
          // "none" rather than promising search and failing to deliver it, so
          // this degradation stays silent — the one the issue leaves standing.
          const turn = await turnFor(baseProvider);

          expect(turn.stream.tools).not.toHaveProperty("web_search");
          expect(turn.searchUnavailable).toBe(false);
        });

        // The boundary the feature rests on: the model is not told, so an
        // unavailable-search turn must be indistinguishable — prompt and tools
        // alike — from a turn that never asked for search. No stub `web_search`
        // is served, and no system-prompt fragment explains the absence.
        it("changes neither the system prompt nor the tool set the model sees", async () => {
          const unavailable = await turnFor(searxProvider);
          const neverAsked = await turnFor(googleProvider, false);

          expect(unavailable.searchUnavailable).toBe(true);
          expect(unavailable.stream.system).toBe(neverAsked.stream.system);
          expect(Object.keys(unavailable.stream.tools ?? {})).toEqual(
            Object.keys(neverAsked.stream.tools ?? {}),
          );
          expect(unavailable.stream.tools).not.toHaveProperty("web_search");
          expect(unavailable.stream.tools).not.toHaveProperty("read_url");
        });
      });
    });

    // Issue #342: the model must actually receive extracted text on the
    // non-native branch, and the untouched real file on the native one. Built
    // with `origin: undefined` so inlining is skipped — the attachment already
    // carries its bytes as a data: URL, which is what inlining would produce.
    describe("document attachments", () => {
      const pdfMessages = (
        filename = "report.pdf",
        lines = ["Revenue is up"],
      ) =>
        [
          {
            id: "m1",
            role: "user",
            parts: [
              {
                type: "file",
                mediaType: "application/pdf",
                filename,
                url: `data:application/pdf;base64,${buildTestPdf(lines).toString("base64")}`,
              },
            ],
          },
        ] as unknown as PlatypusUIMessage[];

      const turnWithProvider = async (
        provider: Omit<typeof baseProvider, "modelIds"> & {
          modelIds: Array<{
            id: string;
            passthroughFileTypes: string[];
            maxExtractedTextChars?: number;
          }>;
        },
        messages: PlatypusUIMessage[],
      ) =>
        prepareChatTurn(
          {
            ...baseInput,
            origin: undefined,
            messages,
            request: { providerId: provider.id, modelId: "gpt-4" },
          },
          createInMemoryChatTurnQueries({
            workspaces: [baseWorkspace],
            providers: [provider],
          }),
        );

      beforeEach(() => {
        resetExtractedTextCache();
      });

      it("sends a non-native PDF to the model as annotated extracted text", async () => {
        const turn = await turnWithProvider(baseProvider, pdfMessages());
        const parts = (turn.stream.messages[0] as { parts: unknown[] }).parts;
        const part = parts[0] as { type: string; text: string };
        expect(part.type).toBe("text");
        expect(part.text).toContain("[extracted text from report.pdf]");
        expect(part.text).toContain("Revenue is up");
      });

      it("leaves a PDF the model accepts natively byte-for-byte unchanged", async () => {
        const messages = pdfMessages();
        const nativeProvider = {
          ...baseProvider,
          modelIds: [
            { id: "gpt-4", passthroughFileTypes: ["application/pdf"] },
          ],
        };
        const turn = await turnWithProvider(nativeProvider, messages);
        const parts = (turn.stream.messages[0] as { parts: unknown[] }).parts;
        expect(parts[0]).toEqual(
          (messages[0] as unknown as { parts: unknown[] }).parts[0],
        );
      });

      it("honours the model's maxExtractedTextChars cap", async () => {
        const cappedProvider = {
          ...baseProvider,
          modelIds: [
            {
              id: "gpt-4",
              passthroughFileTypes: [],
              maxExtractedTextChars: 20,
            },
          ],
        };
        const turn = await turnWithProvider(
          cappedProvider,
          pdfMessages(
            "long.pdf",
            Array.from({ length: 10 }, () => "many words here"),
          ),
        );
        const parts = (turn.stream.messages[0] as { parts: unknown[] }).parts;
        const part = parts[0] as { type: string; text: string };
        expect(part.text).toMatch(
          /\[extracted text truncated: first 20 of \d+ characters\]/,
        );
      });
    });
  });

  describe("Static tool-set resolution", () => {
    it("costs a throwing tool set its own tools, not the turn, and never falls back to MCP", async () => {
      const toolSetId = "test.throwing-factory";
      registerToolSet(
        toolSetId,
        composeToolSet({
          id: toolSetId,
          pluginName: "test-plugin",
          contribution: {
            name: "Throwing test Tool set",
            category: "Test",
            tools: vi
              .fn()
              .mockRejectedValue(new Error("tool-set factory failed")),
          },
        }),
      );

      const workingId = "test.working-set";
      registerToolSet(
        workingId,
        composeToolSet({
          id: workingId,
          pluginName: "test-plugin",
          contribution: {
            name: "Working test Tool set",
            category: "Test",
            tools: { stillHere: { description: "x" } as never },
          },
        }),
      );

      const agentWithToolSets = {
        ...baseAgent,
        toolSetIds: [toolSetId, workingId],
      };
      const queries = createInMemoryChatTurnQueries({
        workspaces: [baseWorkspace],
        agents: [agentWithToolSets],
        providers: [baseProvider],
      });
      const getMcp = vi.spyOn(queries, "getMcp");

      const turn = await prepareChatTurn(
        { ...baseInput, request: { agentId: agentWithToolSets.id } },
        queries,
      );

      // The turn runs, without the broken plugin's tools and with everything
      // else the Agent was granted.
      expect(turn.stream.tools).toHaveProperty("stillHere");
      // A registered id is never re-read as an MCP, however its factory ended.
      expect(getMcp).not.toHaveBeenCalled();
    });
  });

  describe("MCP tool-set resolution", () => {
    const baseMcp = {
      id: "mcp-1",
      organizationId: null as string | null,
      workspaceId: null as string | null,
      name: "Test MCP",
      slug: "test_mcp",
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
        agents: [agentWithMcp],
        providers: [baseProvider],
        mcps: [orgMcp],
        attachments: [
          {
            workspaceId: baseWorkspace.id,
            resourceType: "mcp",
            resourceId: orgMcp.id,
          },
        ],
      });

      const turn = await prepareChatTurn(
        { ...baseInput, request: { agentId: agentWithMcp.id } },
        queries,
      );

      expect(turn.stream.tools).toHaveProperty("test_mcp__mcpTool");
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
        agents: [agentWithMcp],
        providers: [baseProvider],
        mcps: [orgMcp],
        // no attachments
      });

      const turn = await prepareChatTurn(
        { ...baseInput, request: { agentId: agentWithMcp.id } },
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
        agents: [agentWithMcp],
        providers: [baseProvider],
        mcps: [orgMcp],
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
        { ...baseInput, request: { agentId: agentWithMcp.id } },
        queries,
      );

      expect(turn.stream.tools).not.toHaveProperty("mcpTool");
      await turn.dispose();
    });
  });

  describe("resolveSearchMode", () => {
    // A provider that can serve search natively, so the tests below isolate one
    // condition at a time.
    const native = {
      providerType: "Anthropic" as const,
      apiMode: "responses" as const,
      searchSource: "native",
    };

    it("resolves to native when search is requested and searchSource is native", () => {
      expect(resolveSearchMode(true, native)).toEqual({ kind: "native" });
    });

    it("resolves to the backend named by searchSource", () => {
      // Explicit-plugin-first (ADR-0014): the id travels with the decision, so the
      // injection site never re-derives which of the two paths applies.
      expect(
        resolveSearchMode(true, { ...native, searchSource: "searx" }),
      ).toEqual({ kind: "backend", backend: "searx" });
    });

    it('resolves to none when searchSource is "none"', () => {
      expect(
        resolveSearchMode(true, { ...native, searchSource: "none" }),
      ).toEqual({ kind: "none" });
    });

    it("resolves to none when search is not requested, regardless of provider", () => {
      expect(resolveSearchMode(false, native)).toEqual({ kind: "none" });
      expect(resolveSearchMode(undefined, native)).toEqual({ kind: "none" });
      expect(
        resolveSearchMode(undefined, { ...native, searchSource: "searx" }),
      ).toEqual({ kind: "none" });
    });

    it("treats a row with no stored searchSource as no search", () => {
      expect(
        resolveSearchMode(true, {
          ...native,
          searchSource: undefined as unknown as string,
        }),
      ).toEqual({ kind: "none" });
    });

    it("treats an empty searchSource as no search, not a backend lookup", () => {
      // `providerBaseSchema` transforms `""` to `"none"`, but a row written
      // before that (or by hand) can still hold the empty string — it must
      // read as no search rather than a registry miss and a warn on every
      // turn.
      expect(resolveSearchMode(true, { ...native, searchSource: "" })).toEqual({
        kind: "none",
      });
    });

    it("resolves a stale native selection on a provider with no native search to none", () => {
      // A row backfilled to "native" (ADR-0014) on a Provider with no native
      // tool at all degrades exactly like an unregistered backend id would,
      // rather than being trusted blind.
      const bedrock = {
        ...native,
        providerType: "Bedrock" as const,
      };
      expect(resolveSearchMode(true, bedrock)).toEqual({ kind: "none" });

      const vllm = {
        ...native,
        providerType: "OpenAI" as const,
        apiMode: "chat" as const,
      };
      expect(resolveSearchMode(true, vllm)).toEqual({ kind: "none" });
    });

    it("resolves to the backend on a provider with no native search too", () => {
      // A configured backend is reachable regardless of provider capability —
      // that's the whole point of the extension point (ADR-0014).
      const bedrock = {
        ...native,
        providerType: "Bedrock" as const,
        searchSource: "searx",
      };
      expect(resolveSearchMode(true, bedrock)).toEqual({
        kind: "backend",
        backend: "searx",
      });

      const vllm = {
        ...native,
        providerType: "OpenAI" as const,
        apiMode: "chat" as const,
        searchSource: "searx",
      };
      expect(resolveSearchMode(true, vllm)).toEqual({
        kind: "backend",
        backend: "searx",
      });
    });
  });

  describe("normalizeToolResult", () => {
    it("converts Date fields to ISO-8601 strings", () => {
      const createdAt = new Date("2026-07-13T10:20:30.000Z");
      const result = normalizeToolResult({ id: "b1", createdAt }) as {
        id: string;
        createdAt: string;
      };
      expect(result.createdAt).toBe("2026-07-13T10:20:30.000Z");
      expect(result.id).toBe("b1");
    });

    it("leaves already-JSON-safe values structurally unchanged", () => {
      const value = { a: 1, b: "x", c: [true, null], d: { nested: 2 } };
      expect(normalizeToolResult(value)).toEqual(value);
    });

    it("passes a top-level undefined return through unchanged", () => {
      expect(normalizeToolResult(undefined)).toBeUndefined();
    });
  });

  describe("wrapToolsWithActivity", () => {
    const noop = () => {};

    const wrapSingle = (execute: unknown) => {
      const wrapped = wrapToolsWithActivity(
        {
          t: { execute } as unknown as Parameters<
            typeof wrapToolsWithActivity
          >[0]["t"],
        },
        noop,
      );
      return (wrapped.t as { execute: (a: unknown, o: unknown) => unknown })
        .execute;
    };

    // Activity events and nothing else: normalizing results is the loader
    // seam's job now (`normalizeToolResults`), so it holds whether or not a turn
    // supplies an `onActivity` callback. This wrapper hands the value back
    // exactly as the tool returned it.
    it("passes a resolved result through untouched", async () => {
      const createdAt = new Date("2026-07-13T10:20:30.000Z");
      const execute = wrapSingle(() => Promise.resolve({ createdAt }));
      const result = (await execute({}, {})) as { createdAt: Date };
      expect(result.createdAt).toBe(createdAt);
    });

    it("passes a synchronous result through untouched", () => {
      const createdAt = new Date("2026-07-13T10:20:30.000Z");
      const execute = wrapSingle(() => ({ createdAt }));
      const result = execute({}, {}) as { createdAt: Date };
      expect(result.createdAt).toBe(createdAt);
    });

    it("leaves the async-iterable path intact (yields pass through untouched)", async () => {
      const date = new Date("2026-07-13T10:20:30.000Z");
      const execute = wrapSingle(async function* () {
        await Promise.resolve();
        yield { part: 1, date };
        yield { part: 2 };
      });
      const iterable = execute({}, {}) as AsyncIterable<{
        part: number;
        date?: Date;
      }>;
      const parts: Array<{ part: number; date?: Date }> = [];
      for await (const part of iterable) parts.push(part);
      expect(parts).toEqual([{ part: 1, date }, { part: 2 }]);
      // The Date is yielded verbatim, not serialized to a string.
      expect(parts[0].date).toBeInstanceOf(Date);
    });

    it("brackets a resolved result with start and end activity events", async () => {
      const onActivity = vi.fn<(event: ToolActivityEvent) => void>();
      const wrapped = wrapToolsWithActivity(
        {
          t: {
            execute: () => Promise.resolve({ createdAt: new Date() }),
          } as unknown as Parameters<typeof wrapToolsWithActivity>[0]["t"],
        },
        onActivity,
      );
      await (
        wrapped.t as { execute: (a: unknown, o: unknown) => Promise<unknown> }
      ).execute({}, {});
      expect(onActivity.mock.calls.map(([e]) => e.phase)).toEqual([
        "start",
        "end",
      ]);
      expect(onActivity.mock.calls[1][0].toolName).toBe("t");
    });

    // The end event is what releases the run's per-step hold, so a generator the
    // consumer drains has to produce one — otherwise the stall timer stays off
    // for the rest of the run.
    it("emits the end event once an async-iterable tool is drained", async () => {
      const onActivity = vi.fn<(event: ToolActivityEvent) => void>();
      const wrapped = wrapToolsWithActivity(
        {
          t: {
            execute: async function* () {
              await Promise.resolve();
              yield { part: 1 };
            },
          } as unknown as Parameters<typeof wrapToolsWithActivity>[0]["t"],
        },
        onActivity,
      );
      const iterable = (
        wrapped.t as {
          execute: (a: unknown, o: unknown) => AsyncIterable<unknown>;
        }
      ).execute({}, {});
      expect(onActivity.mock.calls.map(([e]) => e.phase)).toEqual(["start"]);
      for await (const _ of iterable) void _;
      expect(onActivity.mock.calls.map(([e]) => e.phase)).toEqual([
        "start",
        "end",
      ]);
    });
  });
});

describe("validateTurnAttachments", () => {
  // baseProvider is OpenAI apiMode:"chat" → resolves to images-only passthrough.
  const queries = () =>
    createInMemoryChatTurnQueries({
      workspaces: [baseWorkspace],
      providers: [baseProvider],
    });

  // `url` defaults to a bytes-free data URL: enough for the metadata-only
  // classification, and the gate then skips extraction verification. Cases that
  // exercise extraction pass real document bytes.
  const fileMessage = (
    mediaType: string,
    filename: string,
    url = "storage://placeholder",
  ) =>
    ({
      id: "m1",
      role: "user",
      parts: [{ type: "file", mediaType, filename, url }],
    }) as unknown as PlatypusUIMessage;

  const dataUrl = (mediaType: string, content: Buffer) =>
    `data:${mediaType};base64,${content.toString("base64")}`;

  const request = { providerId: "p1", modelId: "gpt-4" };

  it("rejects a binary nothing can convert to text", async () => {
    await expect(
      validateTurnAttachments(
        {
          request,
          messages: [fileMessage("application/zip", "bundle.zip")],
          orgId: "org-1",
          workspaceId: "ws-1",
        },
        queries(),
      ),
    ).rejects.toBeInstanceOf(FileValidationError);
  });

  it("allows a text-based PDF the chat-completions model can't ingest natively (extracted later)", async () => {
    await expect(
      validateTurnAttachments(
        {
          request,
          messages: [
            fileMessage(
              "application/pdf",
              "report.pdf",
              dataUrl("application/pdf", buildTestPdf(["Readable"])),
            ),
            // A history part: a storage reference with no bytes to verify.
            fileMessage(
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              "spec.docx",
            ),
          ],
          orgId: "org-1",
          workspaceId: "ws-1",
        },
        queries(),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a freshly uploaded PDF with no extractable text", async () => {
    await expect(
      validateTurnAttachments(
        {
          request,
          messages: [
            fileMessage(
              "application/pdf",
              "scan.pdf",
              dataUrl("application/pdf", buildTestPdf([])),
            ),
          ],
          orgId: "org-1",
          workspaceId: "ws-1",
        },
        queries(),
      ),
    ).rejects.toBeInstanceOf(FileValidationError);
  });

  it("allows a text-like file (inlined later) and a native image", async () => {
    await expect(
      validateTurnAttachments(
        {
          request,
          messages: [
            fileMessage("application/octet-stream", "notes.md"),
            fileMessage("image/png", "a.png"),
          ],
          orgId: "org-1",
          workspaceId: "ws-1",
        },
        queries(),
      ),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when the turn carries no file parts", async () => {
    await expect(
      validateTurnAttachments(
        {
          request,
          messages: [
            {
              id: "m1",
              role: "user",
              parts: [{ type: "text", text: "hi" }],
            } as unknown as PlatypusUIMessage,
          ],
          orgId: "org-1",
          workspaceId: "ws-1",
        },
        queries(),
      ),
    ).resolves.toBeUndefined();
  });
});
