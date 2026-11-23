import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Tool } from "ai";

vi.mock("../index.ts", () => ({ db: {} }));

vi.mock("../services/event-dispatch.ts", () => ({ dispatchEvent: vi.fn() }));
vi.mock("../services/sub-agent-validation.ts", () => ({
  validateSubAgentAssignment: vi.fn(),
}));
vi.mock("../storage/index.ts", () => ({ getStorage: vi.fn() }));

const { pluginOwners } = vi.hoisted(() => ({
  pluginOwners: new Map<string, string>(),
}));
vi.mock("../plugins/registry.ts", () => ({
  CORE_BUILTIN_OWNER: "core (built-in)",
  getToolSetPlugin: (id: string) => pluginOwners.get(id),
  getSandboxBackendPlugin: () => undefined,
}));

const { mockCreateMCPClient } = vi.hoisted(() => ({
  mockCreateMCPClient: vi.fn(),
}));
vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: mockCreateMCPClient,
  auth: vi.fn(),
}));

import {
  deferCloserRegistrar,
  openToolSession,
  type ToolSession,
  type ToolSessionOptions,
  type ToolSessionScope,
} from "./tool-session.ts";
import { CLOSER_TIMEOUT_MS } from "./closers.ts";
import {
  composeToolSet,
  registerToolSet,
  shareTool,
  TOOL_SET_RESOLVE_TIMEOUT_MS,
} from "./index.ts";
import { CORE_BUILTIN_OWNER } from "../plugins/registry.ts";
import { logger } from "../logger.ts";
import type { mcp as mcpTable } from "../db/schema.ts";
import { makePluginContext } from "../test-utils.ts";

const PLUGIN = makePluginContext();

type McpRow = typeof mcpTable.$inferSelect;

const scope: ToolSessionScope = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  frontendUrl: "http://localhost:3000",
  timezone: "Australia/Melbourne",
  sessionId: "chat-1",
};

const openSession = (
  sessionScope: ToolSessionScope,
  sessionAgent: Parameters<typeof openToolSession>[1],
  queries: Parameters<typeof openToolSession>[2],
  options: Partial<ToolSessionOptions> = {},
): ReturnType<typeof openToolSession> =>
  openToolSession(sessionScope, sessionAgent, queries, {
    withheldToolSetIds: [],
    interactive: false,
    ...options,
  });

const grantedAgent = (...toolSetIds: string[]) => ({
  id: "agent-1",
  toolSetIds,
});

const toolNamed = (name: string): Tool =>
  ({ description: name }) as unknown as Tool;

const connected = (
  tools: Record<string, unknown>,
  readOnlyHints: Record<string, unknown> = {},
) => {
  const close = vi.fn().mockResolvedValue(undefined);
  mockCreateMCPClient.mockResolvedValueOnce({
    listTools: vi.fn().mockResolvedValue({
      tools: Object.keys(tools).map((name) => ({
        name,
        ...(name in readOnlyHints
          ? { annotations: { readOnlyHint: readOnlyHints[name] } }
          : {}),
      })),
    }),
    toolsFromDefinitions: vi.fn().mockReturnValue(tools),
    close,
  });
  return close;
};

const register = (
  id: string,
  tools: Parameters<typeof composeToolSet>[0]["contribution"]["tools"],
  {
    pluginName = CORE_BUILTIN_OWNER,
    isCore = true,
  }: { pluginName?: string; isCore?: boolean } = {},
) => {
  pluginOwners.set(id, pluginName);
  registerToolSet(
    id,
    composeToolSet({
      id,
      pluginName,
      isCore,
      contribution: {
        name: id,
        category: "Test",
        description: "Test set",
        tools,
      },
      plugin: PLUGIN,
    }),
  );
};

const mcpRow = (overrides: Partial<McpRow> = {}): McpRow =>
  ({
    id: "mcp-1",
    organizationId: null,
    workspaceId: "ws-1",
    name: "Test MCP",
    slug: "test_mcp",
    url: "https://mcp.example.com",
    headers: null,
    authType: "None",
    bearerToken: null,
    ...overrides,
  }) as unknown as McpRow;

const queriesFor = (rows: McpRow[]) => ({
  getMcp: vi.fn((id: string) =>
    Promise.resolve(rows.find((r) => r.id === id) ?? null),
  ),
  saveMcpToolListing: vi.fn(() => Promise.resolve()),
  setMcpFetchFailedAt: vi.fn(() => Promise.resolve()),
});

const noMcps = () => queriesFor([]);

const grantDownloads = (id: string) => {
  register(id, {
    fsDownload: toolNamed("fsDownload"),
    fsView: toolNamed("fsView"),
  });
  return grantedAgent(id);
};

describe("openToolSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // why: clearAllMocks keeps queued *Once values; Tool-set registry is file-global, keep ids unique
    mockCreateMCPClient.mockReset();
  });

  it("serves nothing, and needs no lookups, for an Agent with no tool sets", async () => {
    const queries = noMcps();
    const session = await openSession(scope, undefined, queries);

    expect(session.tools).toEqual({});
    expect(queries.getMcp).not.toHaveBeenCalled();
    await expect(session.dispose()).resolves.toBeUndefined();
  });

  it("resolves each registered Tool set with the session's scope", async () => {
    const factory = vi.fn().mockResolvedValue({ alpha: toolNamed("alpha") });
    register("set.alpha", factory);
    register("set.beta", { beta: toolNamed("beta") });

    const session = await openSession(
      scope,
      grantedAgent("set.alpha", "set.beta"),
      noMcps(),
    );

    expect(Object.keys(session.tools).sort()).toEqual(["alpha", "beta"]);
    expect(factory).toHaveBeenCalledWith(
      {
        orgId: "org-1",
        workspaceId: "ws-1",
        agentId: "agent-1",
        userId: "user-1",
        frontendUrl: "http://localhost:3000",
        timezone: "Australia/Melbourne",
        sessionId: "chat-1",
        registerCloser: expect.any(Function) as unknown,
      },
      PLUGIN,
    );
  });

  describe("fsDownload", () => {
    it("is served to an interactive session", async () => {
      const session = await openSession(
        scope,
        grantDownloads("set.download-interactive"),
        noMcps(),
        { interactive: true },
      );

      expect(Object.keys(session.tools).sort()).toEqual([
        "fsDownload",
        "fsView",
      ]);
    });

    it("is withheld from a session no User watches", async () => {
      const session = await openSession(
        scope,
        grantDownloads("set.download-headless"),
        noMcps(),
      );

      expect(Object.keys(session.tools)).toEqual(["fsView"]);
    });
  });

  it("keeps serving the other Tool sets when one's factory throws", async () => {
    register("set.broken", () => {
      throw new Error("no API key");
    });
    register("set.fine", { fine: toolNamed("fine") });

    const session = await openSession(
      scope,
      grantedAgent("set.broken", "set.fine"),
      noMcps(),
    );

    expect(Object.keys(session.tools)).toEqual(["fine"]);
  });

  it("reports a tool name one Tool set takes from another", async () => {
    register(
      "set.first",
      { search: toolNamed("first") },
      { pluginName: "core-a" },
    );
    register(
      "set.second",
      { search: toolNamed("second") },
      { pluginName: "core-b" },
    );

    const session = await openSession(
      scope,
      grantedAgent("set.first", "set.second"),
      noMcps(),
    );

    expect(session.tools.search).toEqual(toolNamed("second"));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "search",
        toolSet: "set.second",
        plugin: "core-b",
        shadowedToolSet: "set.first",
        shadowedPlugin: "core-a",
      }),
      expect.stringContaining("same tool name"),
    );
  });

  it("keeps the first claim of a shared tool and reports no collision", async () => {
    const shared = () =>
      shareTool("test.read", {
        description: "read",
        execute: () => "ok",
      } as unknown as Tool);
    register("shared.first", () => ({ read: shared() }));
    register("shared.second", () => ({ read: shared() }));

    const session = await openSession(
      scope,
      grantedAgent("shared.first", "shared.second"),
      noMcps(),
    );

    expect(Object.keys(session.tools)).toEqual(["read"]);
    expect(session.gateScope.toolSetIds.get("read")).toBe("shared.first");
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("same tool name"),
    );
  });

  it("still reports two Tool sets from the same plugin contesting a name", async () => {
    const origin = { pluginName: "acme", isCore: false };
    register("acme.first", { search: toolNamed("first") }, origin);
    register("acme.second", { search: toolNamed("second") }, origin);

    const session = await openSession(
      scope,
      grantedAgent("acme.first", "acme.second"),
      noMcps(),
    );

    expect(session.tools.acme__search).toEqual(toolNamed("second"));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "acme__search",
        toolSet: "acme.second",
        plugin: "acme",
        shadowedToolSet: "acme.first",
        shadowedPlugin: "acme",
      }),
      expect.stringContaining("same tool name"),
    );
  });

  it("gives two third-party plugins that contribute one tool name distinct names", async () => {
    register(
      "acme.issues",
      { createIssue: toolNamed("acme") },
      { pluginName: "acme", isCore: false },
    );
    register(
      "globex.issues",
      { createIssue: toolNamed("globex") },
      { pluginName: "globex", isCore: false },
    );

    const session = await openSession(
      scope,
      grantedAgent("acme.issues", "globex.issues"),
      noMcps(),
    );

    expect(session.tools.acme__createIssue).toEqual(toolNamed("acme"));
    expect(session.tools.globex__createIssue).toEqual(toolNamed("globex"));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  describe("resolving concurrently (issue #776)", () => {
    const instrumentConcurrentOpens = (servers: number) => {
      const counts = { inFlight: 0, peak: 0 };
      let markAllEntered: () => void = () => {};
      const allEntered = new Promise<void>((r) => (markAllEntered = r));
      const escapeHatch = new Promise<void>((r) => setTimeout(r, 100));

      mockCreateMCPClient.mockImplementation(async () => {
        counts.inFlight += 1;
        counts.peak = Math.max(counts.peak, counts.inFlight);
        if (counts.inFlight === servers) markAllEntered();
        await Promise.race([allEntered, escapeHatch]);
        counts.inFlight -= 1;
        return {
          listTools: vi.fn().mockResolvedValue({ tools: [{ name: "go" }] }),
          toolsFromDefinitions: vi
            .fn()
            .mockReturnValue({ go: toolNamed("go") }),
          close: vi.fn().mockResolvedValue(undefined),
        };
      });
      return counts;
    };

    it("opens every attached MCP at once, so the slowest bounds the turn rather than the sum", async () => {
      const counts = instrumentConcurrentOpens(3);

      const session = await openSession(
        scope,
        grantedAgent("mcp-1", "mcp-2", "mcp-3"),
        queriesFor([
          mcpRow(),
          mcpRow({ id: "mcp-2", name: "Two", slug: "two" }),
          mcpRow({ id: "mcp-3", name: "Three", slug: "three" }),
        ]),
      );

      expect(counts.peak).toBe(3);
      expect(Object.keys(session.tools).sort()).toEqual([
        "test_mcp__go",
        "three__go",
        "two__go",
      ]);
    });

    it("merges in assignment order even when the later Tool set resolves first", async () => {
      const finished: string[] = [];
      let releaseSlow: () => void = () => {};
      const slow = Promise.race([
        new Promise<void>((r) => (releaseSlow = r)),
        new Promise<void>((r) => setTimeout(r, 100)),
      ]);
      register(
        "set.slow",
        async () => {
          await slow;
          finished.push("set.slow");
          return { search: toolNamed("slow") };
        },
        { pluginName: "core-a" },
      );
      register(
        "set.fast",
        () => {
          releaseSlow();
          finished.push("set.fast");
          return Promise.resolve({ search: toolNamed("fast") });
        },
        { pluginName: "core-b" },
      );

      const session = await openSession(
        scope,
        grantedAgent("set.slow", "set.fast"),
        noMcps(),
      );

      expect(finished).toEqual(["set.fast", "set.slow"]);
      expect(session.tools.search).toEqual(toolNamed("fast"));
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: "search",
          toolSet: "set.fast",
          plugin: "core-b",
          shadowedToolSet: "set.slow",
          shadowedPlugin: "core-a",
        }),
        expect.stringContaining("same tool name"),
      );
    });

    it("reports a name an MCP takes from a Tool set assigned before it", async () => {
      register("set.native", { test_mcp__search: toolNamed("native") });
      connected({ search: toolNamed("mcp") });

      const session = await openSession(
        scope,
        grantedAgent("set.native", "mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.tools["test_mcp__search"]).toEqual(toolNamed("mcp"));
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: "test_mcp__search",
          toolSet: "mcp-1",
          mcpSlug: "test_mcp",
          shadowedToolSet: "set.native",
        }),
        expect.stringContaining("same tool name"),
      );
    });

    it("costs a failing Tool set only its own tools when it resolves beside others", async () => {
      register("set.fanout-broken", () => {
        throw new Error("no API key");
      });
      register("set.fanout-fine", { fine: toolNamed("fine") });
      const stranded = vi.fn().mockResolvedValue(undefined);
      mockCreateMCPClient.mockImplementation(
        ({ transport }: { transport: { url: string } }) =>
          Promise.resolve(
            transport.url === "https://broken.example.com"
              ? {
                  listTools: vi.fn().mockRejectedValue(new Error("gone")),
                  toolsFromDefinitions: vi.fn(),
                  close: stranded,
                }
              : {
                  listTools: vi
                    .fn()
                    .mockResolvedValue({ tools: [{ name: "ok" }] }),
                  toolsFromDefinitions: vi
                    .fn()
                    .mockReturnValue({ ok: toolNamed("ok") }),
                  close: vi.fn().mockResolvedValue(undefined),
                },
          ),
      );

      const session = await openSession(
        scope,
        grantedAgent(
          "nope",
          "set.fanout-broken",
          "mcp-3",
          "mcp-1",
          "mcp-2",
          "set.fanout-fine",
        ),
        queriesFor([
          mcpRow({ url: "https://broken.example.com" }),
          mcpRow({ id: "mcp-2", name: "Two", slug: "two" }),
          mcpRow({ id: "mcp-3", name: "Three", slug: "three", url: null }),
        ]),
      );

      expect(Object.keys(session.tools).sort()).toEqual(["fine", "two__ok"]);
      await session.dispose();
      expect(stranded).toHaveBeenCalled();
    });

    it("closes a sibling's connection when a lookup rejects the turn", async () => {
      const close = connected({ a: toolNamed("a") });
      const queries = {
        getMcp: vi.fn((id: string) =>
          id === "mcp-1"
            ? Promise.resolve(mcpRow())
            : Promise.reject(new Error("database is down")),
        ),
        saveMcpToolListing: vi.fn(() => Promise.resolve()),
        setMcpFetchFailedAt: vi.fn(() => Promise.resolve()),
      };

      await expect(
        openSession(scope, grantedAgent("mcp-1", "mcp-2"), queries),
      ).rejects.toThrow("database is down");

      expect(close).toHaveBeenCalled();
    });
  });

  describe("bounded resolution (issue #1135)", () => {
    const never = <T>() => new Promise<T>(() => {});

    it("skips a Tool set whose factory never settles, naming it, and serves the rest", async () => {
      vi.useFakeTimers();
      try {
        register("set.hung-factory", () => never(), { pluginName: "acme" });
        register("set.beside-hung", { fine: toolNamed("fine") });

        const opening = openSession(
          scope,
          grantedAgent("set.hung-factory", "set.beside-hung"),
          noMcps(),
        );
        await vi.advanceTimersByTimeAsync(TOOL_SET_RESOLVE_TIMEOUT_MS);
        const session = await opening;

        expect(Object.keys(session.tools)).toEqual(["fine"]);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            plugin: "acme",
            toolSet: "set.hung-factory",
          }),
          expect.stringContaining("timed out"),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("skips an MCP that connects and never lists its tools, and closes it without waiting for dispose", async () => {
      vi.useFakeTimers();
      try {
        const close = vi.fn().mockResolvedValue(undefined);
        mockCreateMCPClient.mockResolvedValueOnce({
          listTools: vi.fn(() => never()),
          toolsFromDefinitions: vi.fn(),
          close,
        });

        const opening = openSession(
          scope,
          grantedAgent("mcp-1"),
          queriesFor([mcpRow()]),
        );
        await vi.advanceTimersByTimeAsync(TOOL_SET_RESOLVE_TIMEOUT_MS);
        const session = await opening;

        expect(session.tools).toEqual({});
        expect(close).toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ mcpId: "mcp-1" }),
          expect.stringContaining("did not answer"),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("closes an MCP whose connection lands after its deadline has passed", async () => {
      vi.useFakeTimers();
      try {
        const close = vi.fn().mockResolvedValue(undefined);
        let land: () => void = () => {};
        mockCreateMCPClient.mockReturnValueOnce(
          new Promise((resolve) => {
            land = () =>
              resolve({
                listTools: vi.fn(() => never()),
                toolsFromDefinitions: vi.fn(),
                close,
              });
          }),
        );

        const opening = openSession(
          scope,
          grantedAgent("mcp-1"),
          queriesFor([mcpRow()]),
        );
        await vi.advanceTimersByTimeAsync(TOOL_SET_RESOLVE_TIMEOUT_MS);
        await opening;
        land();
        await vi.advanceTimersByTimeAsync(0);

        expect(close).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops waiting the moment the run is aborted, well inside the deadline", async () => {
      register("set.hung-until-abort", () => never());
      register("set.beside-abort", { fine: toolNamed("fine") });
      mockCreateMCPClient.mockReturnValueOnce(never());
      const run = new AbortController();

      const opening = openSession(
        scope,
        grantedAgent("set.hung-until-abort", "mcp-1", "set.beside-abort"),
        queriesFor([mcpRow()]),
        { signal: run.signal },
      );
      run.abort(new Error("cancelled"));
      const session = await opening;

      expect(Object.keys(session.tools)).toEqual(["fine"]);
    });
  });

  describe("the MCP branch", () => {
    it("serves an MCP server's tools, namespaced under its slug, for an id no Tool set claims, and closes it on dispose", async () => {
      const close = connected({ mcpTool: toolNamed("mcpTool") });

      const session = await openSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.tools).toHaveProperty("test_mcp__mcpTool");
      expect(session.tools).not.toHaveProperty("mcpTool");
      expect(close).not.toHaveBeenCalled();

      await session.dispose();
      expect(close).toHaveBeenCalledTimes(1);

      await session.dispose();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("normalizes an MCP tool's result", async () => {
      const createdAt = new Date("2026-08-06T00:00:00.000Z");
      connected({
        listItems: {
          execute: () => Promise.resolve({ createdAt }),
        },
      });

      const session = await openSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow()]),
      );
      const execute = (
        session.tools["test_mcp__listItems"] as unknown as {
          execute: (a: unknown, o: unknown) => Promise<unknown>;
        }
      ).execute;

      await expect(execute({}, {})).resolves.toEqual({
        createdAt: createdAt.toISOString(),
      });
    });

    it("fails soft when the server is unreachable, leaving nothing to close", async () => {
      mockCreateMCPClient.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      register("set.survivor", { fine: toolNamed("fine") });

      const session = await openSession(
        scope,
        grantedAgent("mcp-1", "set.survivor"),
        queriesFor([mcpRow()]),
      );

      expect(Object.keys(session.tools)).toEqual(["fine"]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ mcpId: "mcp-1", scope: "ws" }),
        expect.stringContaining("unreachable"),
      );
      await expect(session.dispose()).resolves.toBeUndefined();
    });

    it("closes a server that connects and then fails to list its tools", async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      mockCreateMCPClient.mockResolvedValueOnce({
        listTools: vi.fn().mockRejectedValue(new Error("protocol error")),
        close,
      });

      const session = await openSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.tools).toEqual({});
      await session.dispose();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("warns for an MCP with no URL configured", async () => {
      const session = await openSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow({ url: null })]),
      );

      expect(session.tools).toEqual({});
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("has no URL configured"),
      );
      expect(mockCreateMCPClient).not.toHaveBeenCalled();
    });

    it("warns for an id that is neither a Tool set nor an MCP", async () => {
      const session = await openSession(scope, grantedAgent("ghost"), noMcps());

      expect(session.tools).toEqual({});
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("not found as static tool set or MCP"),
      );
    });

    it("does not let an MCP tool shadow a Tool set's same-named tool", async () => {
      register(
        "set.search",
        { search: toolNamed("native") },
        { pluginName: "search-plugin" },
      );
      connected({ search: toolNamed("mcp") });

      const session = await openSession(
        scope,
        grantedAgent("set.search", "mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.tools.search).toEqual(toolNamed("native"));
      expect(session.tools["test_mcp__search"]).toEqual(toolNamed("mcp"));
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("namespaces a tool name that already looks namespaced, rather than stripping it", async () => {
      connected({ github__pull: toolNamed("pull") });

      const session = await openSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow({ name: "GitHub", slug: "github" })]),
      );

      expect(session.tools).toHaveProperty("github__github__pull");
    });

    it("lets two MCPs with distinct slugs both contribute a tool of the same raw name", async () => {
      connected({ search: toolNamed("from-one") });
      connected({ search: toolNamed("from-two") });

      const session = await openSession(
        scope,
        grantedAgent("mcp-1", "mcp-2"),
        queriesFor([
          mcpRow(),
          mcpRow({ id: "mcp-2", name: "Other MCP", slug: "other_mcp" }),
        ]),
      );

      expect(session.tools["test_mcp__search"]).toEqual(toolNamed("from-one"));
      expect(session.tools["other_mcp__search"]).toEqual(toolNamed("from-two"));
    });

    it("excludes a tool whose namespaced name exceeds the model-provider name limit, keeping the MCP's other tools", async () => {
      const longSlug = "a".repeat(60);
      connected({
        ok: toolNamed("ok"),
        thisNameIsWayTooLongToFitOnceNamespaced: toolNamed("too-long"),
      });

      const session = await openSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow({ slug: longSlug })]),
      );

      expect(session.tools).toHaveProperty(`${longSlug}__ok`);
      expect(Object.keys(session.tools)).toEqual([`${longSlug}__ok`]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpId: "mcp-1",
          tool: "thisNameIsWayTooLongToFitOnceNamespaced",
        }),
        expect.stringContaining("exceeds the model-provider name limit"),
      );
    });

    it("fails the turn loudly when two attached MCPs resolve to the same slug, closing both", async () => {
      const first = connected({ a: toolNamed("a") });
      const second = connected({ b: toolNamed("b") });

      await expect(
        openSession(
          scope,
          grantedAgent("mcp-1", "mcp-2"),
          queriesFor([
            mcpRow(),
            mcpRow({ id: "mcp-2", name: "Test MCP Again" }),
          ]),
        ),
      ).rejects.toThrow(
        'Two attached MCPs resolve to the same tool-namespace slug "test_mcp": "Test MCP" (mcp-1) and "Test MCP Again" (mcp-2). Rename one of them.',
      );

      expect(first).toHaveBeenCalled();
      expect(second).toHaveBeenCalled();
    });

    it("closes every connection even when one close throws", async () => {
      const failing = vi.fn().mockRejectedValue(new Error("socket gone"));
      mockCreateMCPClient.mockResolvedValueOnce({
        listTools: vi.fn().mockResolvedValue({ tools: [{ name: "a" }] }),
        toolsFromDefinitions: vi.fn().mockReturnValue({ a: toolNamed("a") }),
        close: failing,
      });
      const second = connected({ b: toolNamed("b") });

      const session = await openSession(
        scope,
        grantedAgent("mcp-1", "mcp-2"),
        queriesFor([
          mcpRow(),
          mcpRow({ id: "mcp-2", name: "Second MCP", slug: "second_mcp" }),
        ]),
      );

      await expect(session.dispose()).resolves.toBeUndefined();
      expect(failing).toHaveBeenCalled();
      expect(second).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: new Error("socket gone") }),
        "Error closing a tool session's connection",
      );
    });
  });

  describe("unloaded Tool sets (issue #1184)", () => {
    it("lists nothing when every granted Tool set loads", async () => {
      register("set.loads", { fine: toolNamed("fine") });
      connected({ mcpTool: toolNamed("mcpTool") });

      const session = await openSession(
        scope,
        grantedAgent("set.loads", "mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.unloadedToolSets).toEqual([]);
    });

    it("lists an id that is neither a Tool set nor an MCP as not found", async () => {
      const session = await openSession(
        scope,
        grantedAgent("deleted-set"),
        noMcps(),
      );

      expect(session.unloadedToolSets).toEqual([
        { toolSetId: "deleted-set", name: null, reason: "not_found" },
      ]);
    });

    it("lists an MCP with no URL as misconfigured", async () => {
      const session = await openSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow({ url: null, name: "Jira" })]),
      );

      expect(session.unloadedToolSets).toEqual([
        { toolSetId: "mcp-1", name: "Jira", reason: "misconfigured" },
      ]);
    });

    it("lists an unreachable MCP with no last-known listing as unreachable", async () => {
      mockCreateMCPClient.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const session = await openSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow({ name: "Jira" })]),
      );

      expect(session.unloadedToolSets).toEqual([
        { toolSetId: "mcp-1", name: "Jira", reason: "unreachable" },
      ]);
    });

    it("never connects to an MCP saved with a URL now blocked, and fails it soft", async () => {
      const queries = queriesFor([
        mcpRow({ name: "Jira", url: "http://169.254.169.254/mcp" }),
      ]);

      const session = await openSession(scope, grantedAgent("mcp-1"), queries);

      expect(session.tools).toEqual({});
      expect(session.unloadedToolSets).toEqual([
        { toolSetId: "mcp-1", name: "Jira", reason: "unreachable" },
      ]);
      expect(mockCreateMCPClient).not.toHaveBeenCalled();
      expect(queries.setMcpFetchFailedAt).toHaveBeenCalledWith(
        "mcp-1",
        expect.any(Date),
      );
    });

    it("lists an MCP that never answers as unreachable", async () => {
      vi.useFakeTimers();
      try {
        mockCreateMCPClient.mockResolvedValueOnce({
          listTools: vi.fn(() => new Promise(() => {})),
          toolsFromDefinitions: vi.fn(),
          close: vi.fn().mockResolvedValue(undefined),
        });

        const opening = openSession(
          scope,
          grantedAgent("mcp-1"),
          queriesFor([mcpRow()]),
        );
        await vi.advanceTimersByTimeAsync(TOOL_SET_RESOLVE_TIMEOUT_MS);
        const session = await opening;

        expect(session.unloadedToolSets).toEqual([
          { toolSetId: "mcp-1", name: "Test MCP", reason: "unreachable" },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("lists an MCP that rejects its credentials as unauthorized", async () => {
      mockCreateMCPClient.mockRejectedValueOnce(
        Object.assign(new Error("denied"), {
          name: "MCPClientError",
          statusCode: 401,
        }),
      );

      const session = await openSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.unloadedToolSets).toEqual([
        { toolSetId: "mcp-1", name: "Test MCP", reason: "unauthorized" },
      ]);
    });

    it("lists a Tool set whose factory throws as factory failed, by its name", async () => {
      register("set.unloaded-throws", () => {
        throw new Error("boom");
      });

      const session = await openSession(
        scope,
        grantedAgent("set.unloaded-throws"),
        noMcps(),
      );

      expect(session.unloadedToolSets).toEqual([
        {
          toolSetId: "set.unloaded-throws",
          name: "set.unloaded-throws",
          reason: "factory_failed",
        },
      ]);
    });

    it("lists a Tool set whose factory times out as factory failed", async () => {
      vi.useFakeTimers();
      try {
        register("set.unloaded-hangs", () => new Promise(() => {}));

        const opening = openSession(
          scope,
          grantedAgent("set.unloaded-hangs"),
          noMcps(),
        );
        await vi.advanceTimersByTimeAsync(TOOL_SET_RESOLVE_TIMEOUT_MS);
        const session = await opening;

        expect(session.unloadedToolSets).toEqual([
          expect.objectContaining({
            toolSetId: "set.unloaded-hangs",
            reason: "factory_failed",
          }),
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not list a factory that deliberately serves no tools", async () => {
      register("set.serves-none", () => ({}));

      const session = await openSession(
        scope,
        grantedAgent("set.serves-none"),
        noMcps(),
      );

      expect(session.unloadedToolSets).toEqual([]);
    });

    it("records nothing for a run cancelled while its Tool sets resolve", async () => {
      register("set.unloaded-until-abort", () => new Promise(() => {}));
      mockCreateMCPClient.mockReturnValueOnce(new Promise(() => {}));
      const run = new AbortController();

      const opening = openSession(
        scope,
        grantedAgent("set.unloaded-until-abort", "mcp-1"),
        queriesFor([mcpRow()]),
        { signal: run.signal },
      );
      run.abort(new Error("cancelled"));
      const session = await opening;

      expect(session.unloadedToolSets).toEqual([]);
    });

    it("keeps a delegate's unloaded Tool sets out of the parent's list", async () => {
      const parent = await openSession(scope, grantedAgent(), noMcps());
      const child = await parent.nest({
        id: "agent-2",
        toolSetIds: ["deleted-set"],
      });

      expect(child.unloadedToolSets).toHaveLength(1);
      expect(parent.unloadedToolSets).toEqual([]);
    });
  });

  describe("MCP read-only hints (issue #626)", () => {
    it("carries a declared read-only hint through, keyed by the namespaced name", async () => {
      connected({ readTool: toolNamed("readTool") }, { readTool: true });

      const session = await openSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.readOnlyToolNames.has("test_mcp__readTool")).toBe(true);
    });

    it("treats a declared writes hint as not read-only", async () => {
      connected({ writeTool: toolNamed("writeTool") }, { writeTool: false });

      const session = await openSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.readOnlyToolNames.has("test_mcp__writeTool")).toBe(false);
    });

    it("treats an undeclared hint as not read-only", async () => {
      connected({ plainTool: toolNamed("plainTool") });

      const session = await openSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.readOnlyToolNames.has("test_mcp__plainTool")).toBe(false);
    });

    it("treats a non-boolean hint as not read-only", async () => {
      connected(
        { sneaky: toolNamed("sneaky") },
        { sneaky: "true" as unknown as boolean },
      );

      const session = await openSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.readOnlyToolNames.has("test_mcp__sneaky")).toBe(false);
    });

    it("carries no hint for a Tool set that is not an MCP", async () => {
      register("set.readOnlyHints.plain", { plain: toolNamed("plain") });

      const session = await openSession(
        scope,
        grantedAgent("set.readOnlyHints.plain"),
        noMcps(),
      );

      expect(session.readOnlyToolNames.size).toBe(0);
    });
  });

  describe("Tool gate scope (ADR-0033)", () => {
    it("tells a gate each tool's origin and declared hint, and that a User is watching", async () => {
      register("set.gate-scope", { plain: toolNamed("plain") });
      connected(
        {
          readTool: toolNamed("readTool"),
          writeTool: toolNamed("writeTool"),
          plainTool: toolNamed("plainTool"),
        },
        { readTool: true, writeTool: false },
      );

      const session = await openSession(
        scope,
        grantedAgent("set.gate-scope", "mcp-1"),
        queriesFor([mcpRow()]),
        { interactive: true },
      );

      expect(session.gateScope).toEqual({
        orgId: "org-1",
        workspaceId: "ws-1",
        agentId: "agent-1",
        attended: true,
        toolSetIds: new Map([
          ["plain", "set.gate-scope"],
          ["test_mcp__readTool", "mcp-1"],
          ["test_mcp__writeTool", "mcp-1"],
          ["test_mcp__plainTool", "mcp-1"],
        ]),
        readOnlyHints: new Map([
          ["test_mcp__readTool", "read-only"],
          ["test_mcp__writeTool", "writes"],
        ]),
      });
    });

    it("marks a delegate's session unattended under its own Agent, even from an attended turn", async () => {
      const parent = await openSession(scope, grantedAgent(), noMcps(), {
        interactive: true,
      });
      const child = await parent.nest({ id: "sub-agent-1", toolSetIds: [] });

      expect(child.gateScope).toMatchObject({
        agentId: "sub-agent-1",
        attended: false,
      });
    });

    it("is unattended when no User is watching", async () => {
      const session = await openSession(scope, undefined, noMcps());

      expect(session.gateScope.attended).toBe(false);
      expect(session.gateScope.agentId).toBeUndefined();
    });
  });

  describe("registered closers", () => {
    const registering = (id: string, close: () => Promise<void> | void) =>
      register(
        id,
        (ctx) => {
          ctx.registerCloser(close);
          return {};
        },
        { pluginName: "acme", isCore: false },
      );

    it("closes what a Tool-set factory registered, once, on dispose", async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      registering("set.pooled", close);

      const session = await openSession(
        scope,
        grantedAgent("set.pooled"),
        noMcps(),
      );

      expect(close).not.toHaveBeenCalled();
      await session.dispose();
      expect(close).toHaveBeenCalledTimes(1);

      await session.dispose();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("resolves a factory that registers nothing exactly as before", async () => {
      register("set.plain", () => ({ plain: toolNamed("plain") }));

      const session = await openSession(
        scope,
        grantedAgent("set.plain"),
        noMcps(),
      );

      expect(session.tools).toHaveProperty("plain");
      await expect(session.dispose()).resolves.toBeUndefined();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("closes at once when registered after dispose", async () => {
      const session = await openSession(scope, grantedAgent(), noMcps());
      await session.dispose();

      const close = vi.fn().mockResolvedValue(undefined);
      session.registerCloser(close);

      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    });

    it("closes once for the same function registered twice", async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      registering("set.a", close);
      registering("set.b", close);

      const session = await openSession(
        scope,
        grantedAgent("set.a", "set.b"),
        noMcps(),
      );
      await session.dispose();

      expect(close).toHaveBeenCalledTimes(1);
    });

    it("keeps closing the rest when one closer throws, and names the culprit", async () => {
      const failing = vi.fn().mockRejectedValue(new Error("pool already gone"));
      const after = vi.fn().mockResolvedValue(undefined);
      registering("set.failing", failing);
      registering("set.after", after);

      const session = await openSession(
        scope,
        grantedAgent("set.failing", "set.after"),
        noMcps(),
      );
      await expect(session.dispose()).resolves.toBeUndefined();

      expect(failing).toHaveBeenCalledTimes(1);
      expect(after).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ plugin: "acme", toolSet: "set.failing" }),
        expect.stringContaining("Error closing"),
      );
    });

    it("abandons a closer that never settles, and still disposes", async () => {
      vi.useFakeTimers();
      try {
        const hung = vi.fn(() => new Promise<void>(() => {}));
        const after = vi.fn().mockResolvedValue(undefined);
        registering("set.hung", hung);
        registering("set.next", after);

        const session = await openSession(
          scope,
          grantedAgent("set.hung", "set.next"),
          noMcps(),
        );

        const disposed = session.dispose();
        await vi.advanceTimersByTimeAsync(CLOSER_TIMEOUT_MS);
        await expect(disposed).resolves.toBeUndefined();

        expect(after).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ plugin: "acme", toolSet: "set.hung" }),
          expect.stringContaining("did not settle in time"),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores, with a warning, anything registered that is not a function", async () => {
      register(
        "set.js-plugin",
        (ctx) => {
          (ctx.registerCloser as unknown as (c: unknown) => void)("close me");
          return {};
        },
        { pluginName: "acme", isCore: false },
      );

      const session = await openSession(
        scope,
        grantedAgent("set.js-plugin"),
        noMcps(),
      );

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          plugin: "acme",
          toolSet: "set.js-plugin",
          received: "string",
        }),
        expect.stringContaining("not a function"),
      );
      await expect(session.dispose()).resolves.toBeUndefined();
    });

    it("bounds an MCP client whose close hangs", async () => {
      vi.useFakeTimers();
      try {
        mockCreateMCPClient.mockResolvedValueOnce({
          listTools: vi.fn().mockResolvedValue({ tools: [{ name: "a" }] }),
          toolsFromDefinitions: vi.fn().mockReturnValue({ a: toolNamed("a") }),
          close: vi.fn(() => new Promise<void>(() => {})),
        });

        const session = await openSession(
          scope,
          grantedAgent("mcp-1"),
          queriesFor([mcpRow()]),
        );

        const disposed = session.dispose();
        await vi.advanceTimersByTimeAsync(CLOSER_TIMEOUT_MS);
        await expect(disposed).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ mcpId: "mcp-1", scope: "ws" }),
          expect.stringContaining("did not settle in time"),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("deferCloserRegistrar", () => {
    it("registers onto a session that has not opened yet", async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      let resolveSession: (s: ToolSession) => void = () => {};
      const pending = new Promise<ToolSession>((resolve) => {
        resolveSession = resolve;
      });

      deferCloserRegistrar(pending)(close);

      const session = await openSession(scope, grantedAgent(), noMcps());
      resolveSession(session);
      await pending;
      expect(close).not.toHaveBeenCalled();

      await session.dispose();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("runs the closer itself when the session never opened", async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      const failed = Promise.reject<ToolSession>(new Error("no session"));

      deferCloserRegistrar(failed)(close);

      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    });
  });

  describe("nested sessions", () => {
    it("keeps a delegate's tools to itself and closes them with the parent", async () => {
      register("set.parent", { parentTool: toolNamed("parentTool") });
      const parent = await openSession(
        scope,
        grantedAgent("set.parent"),
        queriesFor([mcpRow()]),
      );

      const close = connected({ delegateTool: toolNamed("delegateTool") });
      const child = await parent.nest({
        id: "sub-agent-1",
        toolSetIds: ["mcp-1"],
      });

      expect(child.tools).toHaveProperty("test_mcp__delegateTool");
      expect(parent.tools).not.toHaveProperty("test_mcp__delegateTool");

      await parent.dispose();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("namespaces a Sub-Agent's third-party Tool set by the same rule", async () => {
      register(
        "acme.sub-664",
        { createIssue: toolNamed("createIssue") },
        { pluginName: "acme", isCore: false },
      );
      const parent = await openSession(scope, undefined, noMcps());

      const child = await parent.nest({
        id: "sub-agent-1",
        toolSetIds: ["acme.sub-664"],
      });

      expect(Object.keys(child.tools)).toEqual(["acme__createIssue"]);
      await parent.dispose();
    });

    it("resolves a delegate's read-only hints independently of the parent's", async () => {
      register("set.parent.readOnlyHints", {
        parentTool: toolNamed("parentTool"),
      });
      const parent = await openSession(
        scope,
        grantedAgent("set.parent.readOnlyHints"),
        queriesFor([mcpRow()]),
      );
      expect(parent.readOnlyToolNames.size).toBe(0);

      connected(
        { delegateTool: toolNamed("delegateTool") },
        { delegateTool: true },
      );
      const child = await parent.nest({
        id: "sub-agent-1",
        toolSetIds: ["mcp-1"],
      });

      expect(child.readOnlyToolNames.has("test_mcp__delegateTool")).toBe(true);
      expect(parent.readOnlyToolNames.size).toBe(0);
    });

    it("resolves the delegate's Tool sets under its own Agent id", async () => {
      const factory = vi.fn().mockResolvedValue({});
      register("set.delegate", factory);

      const parent = await openSession(scope, grantedAgent(), noMcps());
      await parent.nest({ id: "sub-agent-1", toolSetIds: ["set.delegate"] });

      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "sub-agent-1",
          workspaceId: "ws-1",
          userId: "user-1",
          timezone: "Australia/Melbourne",
        }),
        PLUGIN,
      );
    });

    it("withholds a withheld Tool set from the Agent and from its delegates", async () => {
      register("set.memory", () => ({ memoryGet: toolNamed("memoryGet") }));
      register("set.other", () => ({ other: toolNamed("other") }));

      const parent = await openSession(
        scope,
        grantedAgent("set.memory", "set.other"),
        noMcps(),
        { withheldToolSetIds: ["set.memory"] },
      );
      const child = await parent.nest({
        id: "sub-agent-1",
        toolSetIds: ["set.memory", "set.other"],
      });

      expect(Object.keys(parent.tools)).toEqual(["other"]);
      expect(Object.keys(child.tools)).toEqual(["other"]);
    });

    it.each([
      ["an interactive turn", true],
      ["a Trigger run", false],
    ])(
      "withholds fsDownload, but not fsView, from a delegate of %s",
      async (_, interactive) => {
        const { toolSetIds } = grantDownloads(
          `set.download-nested-${interactive}`,
        );
        const parent = await openSession(scope, undefined, noMcps(), {
          interactive,
        });

        const child = await parent.nest({ id: "sub-agent-1", toolSetIds });

        expect(Object.keys(child.tools)).toEqual(["fsView"]);
        await parent.dispose();
      },
    );

    it("closes a session opened after the parent was already disposed", async () => {
      const parent = await openSession(
        scope,
        grantedAgent(),
        queriesFor([mcpRow()]),
      );
      await parent.dispose();

      const close = connected({ late: toolNamed("late") });
      const child = await parent.nest({
        id: "sub-agent-1",
        toolSetIds: ["mcp-1"],
      });

      expect(close).toHaveBeenCalledTimes(1);
      expect(child.tools).toEqual({});
    });
  });
});
