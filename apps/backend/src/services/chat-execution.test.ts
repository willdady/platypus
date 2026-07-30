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
  NotFoundError,
  ValidationError,
  createToolHeartbeat,
  resolveSearchMode,
  wrapToolsWithBump,
  normalizeToolResult,
} from "./chat-execution.ts";
import {
  clearWebBackends,
  composeWebBackend,
  registerWebBackend,
} from "../web-backends/index.ts";
import { logger } from "../logger.ts";
import { FileValidationError } from "./file-gate.ts";
import { resetExtractedTextCache } from "./file-extraction.ts";
import { buildTestPdf } from "./file-extraction.test-fixtures.ts";
import { createInMemoryChatTurnQueries } from "./chat-execution.test-fixtures.ts";
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
  nativeSearchEnabled: true,
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
      // Direct turns default maxSteps to 1
      expect(turn.stream.maxSteps).toBe(1);
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

      const register = (
        backend: string,
        executors: {
          web_search?: () => { query: string; results: [] };
          read_url?: () => { content: string; url: string };
        } = {},
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
            },
            pluginName: "@acme/searx",
          }),
        );

      // Typed as `Provider`, not `typeof googleProvider`: the fixtures omit
      // `webBackend`, so a `typeof` parameter would reject `{ ...provider,
      // webBackend }` as an excess property and force a cast at every call.
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

        const turn = await turnFor({ ...googleProvider, webBackend: "searx" });

        // Explicit plugin first: core's two Tools, and the native tool neither
        // injected nor even constructed.
        expect(turn.stream.tools).toHaveProperty("web_search");
        expect(turn.stream.tools).toHaveProperty("read_url");
        expect(turn.stream.tools).not.toHaveProperty("google_search");
        expect(googleSearchTool()).not.toHaveBeenCalled();
      });

      it("serves search only, when the backend contributes no read_url", async () => {
        register("searx");

        const turn = await turnFor({ ...googleProvider, webBackend: "searx" });

        expect(turn.stream.tools).toHaveProperty("web_search");
        expect(turn.stream.tools).not.toHaveProperty("read_url");
      });

      it("serves no search tools, and warns, when the stored backend is no longer registered", async () => {
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

        // Nothing registered: the plugin that contributed `searx` was removed
        // from PLATYPUS_PLUGINS after an Operator selected it.
        const turn = await turnFor({ ...googleProvider, webBackend: "searx" });

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
            webBackend: "searx",
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
        const turn = await turnFor({ ...baseProvider, webBackend: "searx" });

        expect(turn.stream.tools).toHaveProperty("web_search");
        expect(
          mockCreateOpenAI.instance.tools.webSearch,
        ).not.toHaveBeenCalled();
      });

      it("serves nothing when the request did not ask for search", async () => {
        register("searx", { read_url: () => ({ content: "", url: "" }) });

        const turn = await turnFor(
          { ...googleProvider, webBackend: "searx" },
          false,
        );

        expect(turn.stream.tools).not.toHaveProperty("web_search");
        expect(turn.stream.tools).not.toHaveProperty("read_url");
      });

      it("serves a backend on a trigger-initiated run, not only an interactive one", async () => {
        // G16: a non-user principal reaches `prepareChatTurn` through
        // `AgentRunner` with `runMode: "headless"`, and resolution must not be
        // gated on the mode — there is one injection site for every run path.
        register("searx", { read_url: () => ({ content: "", url: "" }) });

        const turn = await turnFor(
          { ...googleProvider, webBackend: "searx" },
          true,
          "headless",
        );

        expect(turn.stream.tools).toHaveProperty("web_search");
        expect(turn.stream.tools).toHaveProperty("read_url");
        expect(googleSearchTool()).not.toHaveBeenCalled();
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

  describe("resolveSearchMode", () => {
    // A provider that can serve search natively, so the tests below isolate one
    // condition at a time.
    const native = {
      providerType: "Anthropic" as const,
      apiMode: "responses" as const,
      nativeSearchEnabled: true,
      webBackend: null,
    };

    it("resolves to native when search is requested and the provider has it", () => {
      expect(resolveSearchMode(true, native)).toEqual({ kind: "native" });
    });

    it("resolves to the backend, ahead of native search, when one is set", () => {
      // Explicit-plugin-first (ADR-0014): the id travels with the decision, so the
      // injection site never re-derives which of the two paths applies.
      expect(
        resolveSearchMode(true, { ...native, webBackend: "searx" }),
      ).toEqual({ kind: "backend", backend: "searx" });
    });

    it("resolves to none when the provider's search switch is off", () => {
      expect(
        resolveSearchMode(true, { ...native, nativeSearchEnabled: false }),
      ).toEqual({ kind: "none" });
      // Even with a backend configured: the switch currently means "no search on
      // this provider at all". Deliberate, and the field-naming consequence is
      // PR3's (see PLAN § PR3).
      expect(
        resolveSearchMode(true, {
          ...native,
          nativeSearchEnabled: false,
          webBackend: "searx",
        }),
      ).toEqual({ kind: "none" });
    });

    it("resolves to none when search is not requested, regardless of provider", () => {
      expect(resolveSearchMode(false, native)).toEqual({ kind: "none" });
      expect(resolveSearchMode(undefined, native)).toEqual({ kind: "none" });
      expect(
        resolveSearchMode(undefined, { ...native, webBackend: "searx" }),
      ).toEqual({ kind: "none" });
    });

    it("treats a legacy provider (nativeSearchEnabled undefined) as enabled", () => {
      expect(
        resolveSearchMode(true, {
          ...native,
          nativeSearchEnabled: undefined as unknown as boolean,
        }),
      ).toEqual({ kind: "native" });
    });

    it("serves a provider with no native search only when a web backend is set", () => {
      // Bedrock has no native search tool at all…
      const bedrock = {
        ...native,
        providerType: "Bedrock" as const,
      };
      expect(resolveSearchMode(true, bedrock)).toEqual({ kind: "none" });
      expect(
        resolveSearchMode(true, { ...bedrock, webBackend: "searx" }),
      ).toEqual({ kind: "backend", backend: "searx" });

      // …and neither does an OpenAI-compatible endpoint on the chat API (vLLM,
      // llama.cpp), where the SDK's search tool exists but the endpoint cannot
      // honour it.
      const vllm = {
        ...native,
        providerType: "OpenAI" as const,
        apiMode: "chat" as const,
      };
      expect(resolveSearchMode(true, vllm)).toEqual({ kind: "none" });
      expect(resolveSearchMode(true, { ...vllm, webBackend: "searx" })).toEqual(
        {
          kind: "backend",
          backend: "searx",
        },
      );
    });

    it("normalises an empty webBackend to none, not to a backend lookup", () => {
      // `providerBaseSchema` transforms `""` to null, but a row written before
      // that (or by hand) can still hold the empty string — it must read as "no
      // backend" rather than a registry miss and a warn on every turn.
      expect(resolveSearchMode(true, { ...native, webBackend: "" })).toEqual({
        kind: "native",
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

  describe("wrapToolsWithBump", () => {
    const noop = () => {};

    const wrapSingle = (execute: unknown) => {
      const wrapped = wrapToolsWithBump(
        {
          t: { execute } as unknown as Parameters<
            typeof wrapToolsWithBump
          >[0]["t"],
        },
        noop,
        noop,
        noop,
      );
      return (wrapped.t as { execute: (a: unknown, o: unknown) => unknown })
        .execute;
    };

    it("normalizes a Date-containing result on the promise-resolved path", async () => {
      const execute = wrapSingle(() =>
        Promise.resolve({
          createdAt: new Date("2026-07-13T10:20:30.000Z"),
        }),
      );
      const result = (await execute({}, {})) as { createdAt: string };
      expect(result.createdAt).toBe("2026-07-13T10:20:30.000Z");
    });

    it("normalizes a Date-containing result on the synchronous path", () => {
      const execute = wrapSingle(() => ({
        createdAt: new Date("2026-07-13T10:20:30.000Z"),
      }));
      const result = execute({}, {}) as { createdAt: string };
      expect(result.createdAt).toBe("2026-07-13T10:20:30.000Z");
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

    it("runs the tool lifecycle callbacks around a normalized result", async () => {
      const onStart = vi.fn();
      const onEnd = vi.fn();
      const wrapped = wrapToolsWithBump(
        {
          t: {
            execute: () => Promise.resolve({ createdAt: new Date() }),
          } as unknown as Parameters<typeof wrapToolsWithBump>[0]["t"],
        },
        noop,
        onStart,
        onEnd,
      );
      await (
        wrapped.t as { execute: (a: unknown, o: unknown) => Promise<unknown> }
      ).execute({}, {});
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onEnd).toHaveBeenCalledTimes(1);
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
