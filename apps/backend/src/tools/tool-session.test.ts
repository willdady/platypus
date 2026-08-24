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

import {
  deferCloserRegistrar,
  openToolSession,
  type ToolSession,
  type ToolSessionScope,
} from "./tool-session.ts";
import { CLOSER_TIMEOUT_MS } from "./closers.ts";
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

/**
 * Queues one `createMCPClient` resolution behind the client's own two-step
 * API (`listTools` + `toolsFromDefinitions`, #626) — mocked the way the real
 * one behaves: `toolsFromDefinitions` ignores the definitions it's handed and
 * returns the tools this helper already declared. `readOnlyHints` marks a
 * subset of `tools`'s keys as MCP-declared read-only, for the tests that need
 * one. Shared by every describe block below that opens an MCP connection.
 */
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
    slug: "test_mcp",
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
        // The scope's fields, plus the one capability on the context.
        registerCloser: expect.any(Function) as unknown,
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
    it("serves an MCP server's tools, namespaced under its slug, for an id no Tool set claims, and closes it on dispose", async () => {
      const close = connected({ mcpTool: toolNamed("mcpTool") });

      const session = await openToolSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.tools).toHaveProperty("test_mcp__mcpTool");
      expect(session.tools).not.toHaveProperty("mcpTool");
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
        listTools: vi.fn().mockRejectedValue(new Error("protocol error")),
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

    // The bug issue #467 fixes: an MCP tool literally named `search` (or
    // `web_search`) used to shadow a same-named Tool set or built-in outright.
    // Namespacing means the two names never collide in the first place.
    it("does not let an MCP tool shadow a Tool set's same-named tool", async () => {
      register("set.search", { search: toolNamed("native") }, "search-plugin");
      connected({ search: toolNamed("mcp") });

      const session = await openToolSession(
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

      const session = await openToolSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow({ name: "GitHub", slug: "github" })]),
      );

      expect(session.tools).toHaveProperty("github__github__pull");
    });

    it("lets two MCPs with distinct slugs both contribute a tool of the same raw name", async () => {
      connected({ search: toolNamed("from-one") });
      connected({ search: toolNamed("from-two") });

      const session = await openToolSession(
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

      const session = await openToolSession(
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

    it("fails the turn loudly when two attached MCPs resolve to the same slug", async () => {
      connected({ a: toolNamed("a") });

      await expect(
        openToolSession(
          scope,
          grantedAgent("mcp-1", "mcp-2"),
          queriesFor([
            mcpRow(),
            mcpRow({ id: "mcp-2", name: "Test MCP Again" }),
          ]),
        ),
      ).rejects.toThrow(/same tool-namespace slug "test_mcp"/);
    });

    it("closes every connection even when one close throws", async () => {
      const failing = vi.fn().mockRejectedValue(new Error("socket gone"));
      mockCreateMCPClient.mockResolvedValueOnce({
        listTools: vi.fn().mockResolvedValue({ tools: [{ name: "a" }] }),
        toolsFromDefinitions: vi.fn().mockReturnValue({ a: toolNamed("a") }),
        close: failing,
      });
      const second = connected({ b: toolNamed("b") });

      const session = await openToolSession(
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
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe("MCP read-only hints (issue #626)", () => {
    it("carries a declared read-only hint through, keyed by the namespaced name", async () => {
      connected({ readTool: toolNamed("readTool") }, { readTool: true });

      const session = await openToolSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.readOnlyToolNames.has("test_mcp__readTool")).toBe(true);
    });

    it("treats a declared writes hint as not read-only", async () => {
      connected({ writeTool: toolNamed("writeTool") }, { writeTool: false });

      const session = await openToolSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.readOnlyToolNames.has("test_mcp__writeTool")).toBe(false);
    });

    it("treats an undeclared hint as not read-only", async () => {
      connected({ plainTool: toolNamed("plainTool") });

      const session = await openToolSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.readOnlyToolNames.has("test_mcp__plainTool")).toBe(false);
    });

    // Tri-state, never coerced (ADR-0021): only the boolean `true` counts.
    it("treats a non-boolean hint as not read-only", async () => {
      connected(
        { sneaky: toolNamed("sneaky") },
        { sneaky: "true" as unknown as boolean },
      );

      const session = await openToolSession(
        scope,
        grantedAgent("mcp-1"),
        queriesFor([mcpRow()]),
      );

      expect(session.readOnlyToolNames.has("test_mcp__sneaky")).toBe(false);
    });

    it("carries no hint for a Tool set that is not an MCP", async () => {
      register("set.readOnlyHints.plain", { plain: toolNamed("plain") });

      const session = await openToolSession(
        scope,
        grantedAgent("set.readOnlyHints.plain"),
        noMcps(),
      );

      expect(session.readOnlyToolNames.size).toBe(0);
    });
  });

  describe("registered closers", () => {
    /** A Tool set whose factory registers `close`, guarded as an author's would be. */
    const registering = (id: string, close: () => Promise<void> | void) =>
      register(id, (ctx) => {
        ctx.registerCloser?.(close);
        return {};
      });

    it("closes what a Tool-set factory registered, once, on dispose", async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      registering("set.pooled", close);

      const session = await openToolSession(
        scope,
        grantedAgent("set.pooled"),
        noMcps(),
      );

      expect(close).not.toHaveBeenCalled();
      await session.dispose();
      expect(close).toHaveBeenCalledTimes(1);

      // The caller disposes on abort *and* on finish; the second is a no-op.
      await session.dispose();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("resolves a factory that registers nothing exactly as before", async () => {
      register("set.plain", () => ({ plain: toolNamed("plain") }));

      const session = await openToolSession(
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
      const session = await openToolSession(scope, grantedAgent(), noMcps());
      await session.dispose();

      const close = vi.fn().mockResolvedValue(undefined);
      session.registerCloser(close);

      // Fire-and-forget, so the call lands a microtask after the registration —
      // a delegate unwinding under an abort is the real caller here.
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    });

    it("closes once for the same function registered twice", async () => {
      const close = vi.fn().mockResolvedValue(undefined);
      registering("set.a", close);
      registering("set.b", close);

      const session = await openToolSession(
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

      const session = await openToolSession(
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

        const session = await openToolSession(
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
      register("set.js-plugin", (ctx) => {
        // What the types forbid and a third-party *JS* plugin can still do.
        (ctx.registerCloser as unknown as (c: unknown) => void)?.("close me");
        return {};
      });

      const session = await openToolSession(
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

        const session = await openToolSession(
          scope,
          grantedAgent("mcp-1"),
          queriesFor([mcpRow()]),
        );

        const disposed = session.dispose();
        await vi.advanceTimersByTimeAsync(CLOSER_TIMEOUT_MS);
        // A hanging `close()` used to stall the run's terminal write for the
        // life of the process.
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

      const session = await openToolSession(scope, grantedAgent(), noMcps());
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

      // Nothing else will ever dispose it, so dropping it would leak whatever
      // the Contribution opened for the life of the process.
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    });
  });

  describe("nested sessions", () => {
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
      expect(child.tools).toHaveProperty("test_mcp__delegateTool");
      expect(parent.tools).not.toHaveProperty("test_mcp__delegateTool");

      // One dispose, at the seam that opened everything.
      await parent.dispose();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("resolves a delegate's read-only hints independently of the parent's", async () => {
      register("set.parent.readOnlyHints", {
        parentTool: toolNamed("parentTool"),
      });
      const parent = await openToolSession(
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
