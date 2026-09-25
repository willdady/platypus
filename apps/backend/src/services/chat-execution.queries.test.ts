import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";

const { mockCreateMCPClient, mockRetrieveRecentSummaries } = vi.hoisted(() => ({
  mockCreateMCPClient: vi.fn(),
  mockRetrieveRecentSummaries: vi.fn(),
}));
vi.mock("@ai-sdk/mcp", () => ({
  experimental_createMCPClient: mockCreateMCPClient,
  auth: vi.fn(),
}));
// The live retrieval's own query is `memory-retrieval.test.ts`'s subject.
vi.mock("./memory-retrieval.ts", async (importActual) => ({
  ...(await importActual<typeof import("./memory-retrieval.ts")>()),
  retrieveRecentSummaries: mockRetrieveRecentSummaries,
}));

import { prepareChatTurn } from "./chat-execution.ts";
import { NotFoundError } from "../errors.ts";
import { SANDBOX_TOOLSET_ID } from "../tools/index.ts";

/**
 * `prepareChatTurn` on its default, Drizzle-backed queries — the ones every
 * real turn runs. `chat-execution.test.ts` drives the turn through an in-memory
 * stand-in for them, so the scope rules and the prompt assembly those queries
 * own (Skill name precedence, sub-Agent order, which Context and Sandbox rows
 * belong to this Workspace) are pinned here against seeded rows that include
 * another Workspace's and another Organization's.
 */

const agent = (id: string, scope: Row, extra: Row = {}): Row => ({
  id,
  name: `Agent ${id}`,
  description: `Does ${id} things`,
  workspaceId: null,
  organizationId: null,
  providerId: "p1",
  modelId: "gpt-4",
  maxSteps: 3,
  toolSetIds: [],
  skillIds: [],
  subAgentIds: [],
  ...scope,
  ...extra,
});

const skill = (id: string, name: string, scope: Row, extra: Row = {}): Row => ({
  id,
  name,
  description: `${id} description`,
  workspaceId: null,
  organizationId: null,
  disableModelInvocation: false,
  ...scope,
  ...extra,
});

const attach = (resourceType: string, resourceId: string): Row => ({
  id: `att-${resourceId}`,
  workspaceId: "ws-1",
  resourceType,
  resourceId,
});

const ws1 = { workspaceId: "ws-1" };
const ws2 = { workspaceId: "ws-2" };
const shared = { organizationId: "org-1" };

const world = (agents: Row[] = []) =>
  seedDb({
    workspace: [
      { id: "ws-1", organizationId: "org-1", context: null },
      { id: "ws-2", organizationId: "org-1", context: null },
    ],
    organization: [{ id: "org-1", identityContext: null }],
    provider: [
      {
        id: "p1",
        name: "Test",
        workspaceId: "ws-1",
        organizationId: null,
        providerType: "OpenAI",
        apiKey: "sk-test",
        apiMode: "chat",
        searchSource: "native",
        modelIds: [{ id: "gpt-4", passthroughFileTypes: [] }],
        taskModelId: "gpt-4",
        memoryExtractionModelId: "gpt-4",
      },
    ],
    agent: [
      agent("agent-1", ws1),
      agent("other-ws", ws2),
      agent("shared-loose", shared),
      ...agents,
    ],
    skill: [
      skill("s-ws", "triage", ws1),
      // Loses the name collision to the Workspace's own `triage`.
      skill("s-shared-dup", "triage", shared),
      skill("s-shared", "deploy", shared),
      skill("s-hidden", "hidden-skill", ws1, { disableModelInvocation: true }),
      skill("s-other-ws", "leaked-skill", ws2),
      skill("s-unattached", "unattached-skill", shared),
    ],
    attachment: [attach("skill", "s-shared-dup"), attach("skill", "s-shared")],
    context: [
      { id: "c1", userId: "user-1", workspaceId: null, content: "GLOBAL-CTX" },
      { id: "c2", userId: "user-1", workspaceId: "ws-1", content: "WS1-CTX" },
      { id: "c3", userId: "user-1", workspaceId: "ws-2", content: "WS2-CTX" },
      { id: "c4", userId: "user-2", workspaceId: null, content: "OTHER-USER" },
    ],
    sandbox: [
      {
        id: "sbx-1",
        workspaceId: "ws-1",
        adminEnv: { ADMIN_KEY: "secret-admin" },
        userEnv: { USER_KEY: "secret-user" },
      },
      {
        id: "sbx-2",
        workspaceId: "ws-2",
        adminEnv: { OTHER_WS_KEY: "x" },
        userEnv: {},
      },
    ],
  });

const turnFor = (agentId: string, overrides: Record<string, unknown> = {}) =>
  prepareChatTurn({
    orgId: "org-1",
    workspaceId: "ws-1",
    user: { id: "user-1", name: "Test User" },
    messages: [],
    origin: "http://localhost:4000",
    request: { agentId },
    // Pinned so no memory retrieval runs; memories are not what this pins.
    memorySnapshot: "",
    memoriesReferenceDate: new Date("2026-05-03T12:00:00Z"),
    ...overrides,
  });

describe("prepareChatTurn on the Drizzle-backed queries", () => {
  beforeEach(() => {
    resetMockDb();
  });

  it.each([
    ["another Workspace's Agent", "other-ws"],
    ["a Shared Agent not attached here", "shared-loose"],
  ])("refuses %s", async (_label, id) => {
    world();
    await expect(turnFor(id)).rejects.toThrow(
      new NotFoundError(`Agent '${id}' not found`),
    );
  });

  it("assembles the prompt from this Workspace's visible Skills, Contexts and Sandbox keys only", async () => {
    world([
      agent("caller", ws1, {
        // The prompt only lists env keys to an Agent with the Sandbox tools.
        toolSetIds: [SANDBOX_TOOLSET_ID],
        skillIds: [
          "s-ws",
          "s-shared-dup",
          "s-shared",
          "s-hidden",
          "s-other-ws",
          "s-unattached",
        ],
      }),
    ]);

    const turn = await turnFor("caller");
    const { system } = turn.stream;

    expect(system).toContain("s-ws description");
    expect(system).toContain("s-shared description");
    // A Workspace Skill wins a name collision with an attached Shared one.
    expect(system).not.toContain("s-shared-dup description");
    // Hidden from the model, but still loadable by id.
    expect(system).not.toContain("hidden-skill");
    expect(system).not.toContain("leaked-skill");
    expect(system).not.toContain("unattached-skill");
    expect(turn.stream.tools).toHaveProperty("loadSkill");

    expect(system).toContain("GLOBAL-CTX");
    expect(system).toContain("WS1-CTX");
    expect(system).not.toContain("WS2-CTX");
    expect(system).not.toContain("OTHER-USER");

    // Keys of both env tiers, never their values or another Workspace's keys.
    expect(system).toContain("ADMIN_KEY");
    expect(system).toContain("USER_KEY");
    expect(system).not.toContain("secret-");
    expect(system).not.toContain("OTHER_WS_KEY");

    await turn.dispose();
  });

  it("lists visible sub-Agents in assignment order and reports the rest by id alone", async () => {
    world([
      agent("sub-a", ws1),
      agent("sub-b", ws1),
      agent("caller", ws1, {
        subAgentIds: ["sub-b", "other-ws", "sub-a", "shared-loose"],
      }),
    ]);

    const turn = await turnFor("caller");
    const system = turn.stream.system ?? "";

    const b = system.indexOf("Does sub-b things");
    const a = system.indexOf("Does sub-a things");
    expect(b).toBeGreaterThan(-1);
    expect(a).toBeGreaterThan(b);
    // Unresolved ids are named, but nothing is read off their rows.
    expect(system).toContain("other-ws");
    expect(system).toContain("shared-loose");
    expect(system).not.toContain("Does other-ws things");
    expect(system).not.toContain("Does shared-loose things");

    await turn.dispose();
  });

  it("connects only to MCPs visible in this Workspace", async () => {
    mockCreateMCPClient.mockResolvedValue({
      tools: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
    });
    const mcp = (id: string, scope: Row, extra: Row = {}): Row => ({
      id,
      name: id,
      slug: id.replace(/-/g, "_"),
      url: `https://${id}.example.com`,
      authType: "None",
      headers: null,
      workspaceId: null,
      organizationId: null,
      ...scope,
      ...extra,
    });
    const fake = world([
      agent("caller", ws1, {
        toolSetIds: ["mcp-mine", "mcp-other-ws", "mcp-loose", "mcp-no-url"],
      }),
    ]);
    fake.tables.mcp = [
      mcp("mcp-mine", ws1),
      mcp("mcp-other-ws", ws2),
      mcp("mcp-loose", shared),
      mcp("mcp-no-url", ws1, { url: null }),
    ];

    const turn = await turnFor("caller");

    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
    expect(mockCreateMCPClient).toHaveBeenCalledWith({
      transport: expect.objectContaining({
        url: "https://mcp-mine.example.com",
      }) as unknown,
    });
    await turn.dispose();
  });

  it("retrieves this user's memories when no snapshot is pinned, and lists no env keys without a Sandbox", async () => {
    const fake = world([
      agent("caller", ws1, { toolSetIds: [SANDBOX_TOOLSET_ID] }),
    ]);
    fake.tables.sandbox = [];
    const referenceDate = new Date("2026-05-03T12:00:00Z");
    mockRetrieveRecentSummaries.mockResolvedValue([
      { summaryDate: "2026-05-02", summary: "Likes coffee." },
    ]);

    const turn = await turnFor("caller", {
      memorySnapshot: undefined,
      memoriesReferenceDate: referenceDate,
    });

    expect(mockRetrieveRecentSummaries).toHaveBeenCalledWith(
      "user-1",
      "ws-1",
      referenceDate,
    );
    expect(turn.stream.system).toContain("Likes coffee.");
    expect(turn.stream.system).toContain("## Sandbox");
    expect(turn.stream.system).not.toContain("Available as `$VAR`");
    await turn.dispose();
  });
});
