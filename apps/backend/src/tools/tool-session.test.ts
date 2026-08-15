import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Tool } from "ai";

// Mock the db used by transitive imports (the sandbox tool set, etc.)
vi.mock("../index.ts", () => ({ db: {} }));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../services/event-dispatch.ts", () => ({ dispatchEvent: vi.fn() }));
vi.mock("../services/sub-agent-validation.ts", () => ({
  validateSubAgentAssignment: vi.fn(),
}));
vi.mock("../storage/index.ts", () => ({ getStorage: vi.fn() }));

// Which plugin contributed which Tool set — the loader's answer at boot, and
// what a collision line names.
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
  experimental_createMCPClient: mockCreateMCPClient,
  auth: vi.fn(),
}));

import { openToolSession, type ToolSessionScope } from "./tool-session.ts";
import { composeToolSet, registerToolSet } from "./index.ts";
import { logger } from "../logger.ts";
import type { mcp as mcpTable } from "../db/schema.ts";

type McpRow = typeof mcpTable.$inferSelect;

const scope: ToolSessionScope = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  frontendUrl: undefined,
};

/** The Agent a session resolves for, with the ids it was granted. */
const grantedAgent = (...toolSetIds: string[]) => ({
  id: "agent-1",
  toolSetIds,
});

const toolNamed = (name: string): Tool =>
  ({ description: name }) as unknown as Tool;

/** Register a Tool set through the composed path a plugin's would take. */
const register = (
  id: string,
  tools: Parameters<typeof composeToolSet>[0]["contribution"]["tools"],
  pluginName = "acme",
) => {
  pluginOwners.set(id, pluginName);
  registerToolSet(
    id,
    composeToolSet({
      id,
      pluginName,
      contribution: { name: id, category: "Test", tools },
    }),
  );
};

const mcpRow = (overrides: Partial<McpRow> = {}): McpRow =>
  ({
    id: "mcp-1",
    organizationId: null,
    workspaceId: "ws-1",
    name: "Test MCP",
    url: "https://mcp.example.com",
    headers: null,
    authType: "None",
    bearerToken: null,
    ...overrides,
  }) as unknown as McpRow;

/** A queries seam serving exactly the MCP rows a test declares. */
const queriesFor = (rows: McpRow[]) => ({
  getMcp: vi.fn((id: string) =>
    Promise.resolve(rows.find((r) => r.id === id) ?? null),
  ),
});

const noMcps = () => queriesFor([]);

describe("openToolSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` keeps queued `*Once` values, and the Tool-set registry is
    // module-global for the file — so the connection queue is reset here, and
    // every test registers its Tool sets under ids of its own.
    mockCreateMCPClient.mockReset();
  });

  it("serves nothing, and needs no lookups, for an Agent with no tool sets", async () => {
    const queries = noMcps();
    const session = await openToolSession(scope, undefined, queries);

    expect(session.tools).toEqual({});
    expect(queries.getMcp).not.toHaveBeenCalled();
    await expect(session.dispose()).resolves.toBeUndefined();
  });

  it("resolves each registered Tool set with the session's scope", async () => {
    const factory = vi.fn().mockResolvedValue({ alpha: toolNamed("alpha") });
    register("set.alpha", factory);
    register("set.beta", { beta: toolNamed("beta") });

    const session = await openToolSession(
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
        frontendUrl: undefined,
      },
      undefined,
    );
  });

  it("keeps serving the other Tool sets when one's factory throws", async () => {
    register("set.broken", () => {
      throw new Error("no API key");
    });
    register("set.fine", { fine: toolNamed("fine") });

    const session = await openToolSession(
      scope,
      grantedAgent("set.broken", "set.fine"),
      noMcps(),
    );

    expect(Object.keys(session.tools)).toEqual(["fine"]);
  });

  // Assignment order is the precedence order, as it always was. What is new is
  // that the swap is reported, naming the Tool set and plugin that lost.
  it("reports a tool name one Tool set takes from another", async () => {
    register("set.first", { search: toolNamed("first") }, "first-plugin");
    register("set.second", { search: toolNamed("second") }, "second-plugin");

    const session = await openToolSession(
      scope,
      grantedAgent("set.first", "set.second"),
      noMcps(),
    );

    expect(session.tools.search).toEqual(toolNamed("second"));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "search",
        toolSet: "set.second",
        plugin: "second-plugin",
        shadowedToolSet: "set.first",
        shadowedPlugin: "first-plugin",
      }),
      expect.stringContaining("same tool name"),
    );
  });

  describe("the MCP branch", () => {
    const connected = (tools: Record<string, unknown>) => {
      const close = vi.fn().mockResolvedValue(undefined);
      mockCreateMCPClient.mockResolvedValueOnce({
        tools: vi.fn().mockResolvedValue(tools),
        close,
      });
      return close;
    };

    it("serves an MCP server's tools for an id no Tool set claims, and closes it on dispose", async () => {
      const close = connected({ mcpTool: toolNamed("mcpTool") });

      const session = await openToolSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.tools).toHaveProperty("mcpTool");
      expect(close).not.toHaveBeenCalled();

      await session.dispose();
      expect(close).toHaveBeenCalledTimes(1);

      // Idempotent: the caller runs it on abort and again on finish.
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

      const session = await openToolSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow()]),
      );
      const execute = (
        session.tools.listItems as unknown as {
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

      const session = await openToolSession(
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
        tools: vi.fn().mockRejectedValue(new Error("protocol error")),
        close,
      });

      const session = await openToolSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.tools).toEqual({});
      await session.dispose();
      // The socket used to stay open for the life of the process: the client
      // was only remembered once its tool listing had succeeded.
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("warns for an MCP with no URL configured", async () => {
      const session = await openToolSession(
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
      const session = await openToolSession(
        scope,
        grantedAgent("ghost"),
        noMcps(),
      );

      expect(session.tools).toEqual({});
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("not found as static tool set or MCP"),
      );
    });

    it("reports a tool name an MCP server takes from a Tool set", async () => {
      register("set.shadowed", { search: toolNamed("first") }, "first-plugin");
      connected({ search: toolNamed("mcp") });

      await openToolSession(
        scope,
        grantedAgent("set.shadowed", "mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: "search",
          toolSet: "mcp-1",
          // An MCP server belongs to no plugin, and says so rather than
          // reading as an unanswered question.
          plugin: null,
          shadowedToolSet: "set.shadowed",
          shadowedPlugin: "first-plugin",
        }),
        expect.stringContaining("same tool name"),
      );
    });

    it("closes every connection even when one close throws", async () => {
      const failing = vi.fn().mockRejectedValue(new Error("socket gone"));
      mockCreateMCPClient.mockResolvedValueOnce({
        tools: vi.fn().mockResolvedValue({ a: toolNamed("a") }),
        close: failing,
      });
      const second = connected({ b: toolNamed("b") });

      const session = await openToolSession(
        scope,
        grantedAgent("mcp-1", "mcp-2"),
        queriesFor([mcpRow(), mcpRow({ id: "mcp-2" })]),
      );

      await expect(session.dispose()).resolves.toBeUndefined();
      expect(failing).toHaveBeenCalled();
      expect(second).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe("nested sessions", () => {
    const connected = (tools: Record<string, unknown>) => {
      const close = vi.fn().mockResolvedValue(undefined);
      mockCreateMCPClient.mockResolvedValueOnce({
        tools: vi.fn().mockResolvedValue(tools),
        close,
      });
      return close;
    };

    it("keeps a delegate's tools to itself and closes them with the parent", async () => {
      register("set.parent", { parentTool: toolNamed("parentTool") });
      const parent = await openToolSession(
        scope,
        grantedAgent("set.parent"),
        queriesFor([mcpRow()]),
      );

      const close = connected({ delegateTool: toolNamed("delegateTool") });
      const child = await parent.nest({
        id: "sub-agent-1",
        toolSetIds: ["mcp-1"],
      });

      // The delegate's tools are its own — a parent must not be able to call
      // them directly.
      expect(child.tools).toHaveProperty("delegateTool");
      expect(parent.tools).not.toHaveProperty("delegateTool");

      // One dispose, at the seam that opened everything.
      await parent.dispose();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("resolves the delegate's Tool sets under its own Agent id", async () => {
      const factory = vi.fn().mockResolvedValue({});
      register("set.delegate", factory);

      const parent = await openToolSession(scope, grantedAgent(), noMcps());
      await parent.nest({ id: "sub-agent-1", toolSetIds: ["set.delegate"] });

      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "sub-agent-1",
          // …and under the parent's Workspace and user: a delegated run is a run
          // for the same human, in the same Workspace.
          workspaceId: "ws-1",
          userId: "user-1",
        }),
        undefined,
      );
    });

    it("closes a session opened after the parent was already disposed", async () => {
      const parent = await openToolSession(
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

      // An abort can cancel the turn while a delegate is still unwinding, so a
      // session opened after teardown releases itself rather than leaking…
      expect(close).toHaveBeenCalledTimes(1);
      // …and serves no tools, rather than tools whose connections are shut.
      expect(child.tools).toEqual({});
    });
  });
});
