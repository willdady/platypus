import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Tool } from "ai";
import type { ToolSetContribution } from "@platypuschat/plugin-sdk";
import {
  callTool,
  makePluginContext,
  resetMockDb,
  seedDb,
} from "../test-utils.ts";

import {
  MAX_PLUGIN_TOOL_NAME_LENGTH,
  namespaceToolName,
} from "@platypus/schemas";
import {
  composeToolSet,
  getToolSets,
  getToolSet,
  hasToolSet,
  registerToolSet,
  SANDBOX_TOOLSET_ID,
} from "./index.ts";
import { CORE_BUILTIN_OWNER } from "../plugins/registry.ts";
import { logger } from "../logger.ts";
import {
  LOAD_SKILL_TOOL_NAME,
  RESERVED_TURN_TOOL_NAMES,
  WEB_SEARCH_TOOL_NAME,
} from "./turn-tool-names.ts";
import { z } from "zod";
import {
  clearSandboxBackends,
  registerSandboxBackend,
} from "../sandbox/index.ts";
import type { SandboxBackend } from "../sandbox/types.ts";

describe("Tool Set Registry", () => {
  const registeredIds = () => getToolSets().map((s) => s.id);

  describe("getToolSets", () => {
    it("returns the statically-registered tool sets", () => {
      expect(registeredIds().length).toBeGreaterThan(0);
    });

    it("no longer statically registers the plugin-migrated tool sets", () => {
      for (const id of [
        "math-conversions",
        "time",
        "web-fetch",
        "kanban",
        "triggers",
        "agent-discovery",
        "skill-management",
        "agent-management",
        "notifications",
        "memory",
      ]) {
        expect(registeredIds()).not.toContain(id);
      }
    });

    it("still statically registers the sandbox tool set (core sandbox infra)", () => {
      expect(registeredIds()).toContain(SANDBOX_TOOLSET_ID);
    });
  });

  describe("getToolSet", () => {
    it("returns the sandbox tool set by id", () => {
      const set = getToolSet(SANDBOX_TOOLSET_ID)!;
      expect(set).toBeDefined();
      expect(set.name).toBe("Sandbox");
      expect(set.category).toBe("Sandbox");
      expect(typeof set.buildTurnTools).toBe("function");
      expect(set.staticTools).toBeUndefined();
    });

    it("returns undefined for an unregistered id", () => {
      expect(getToolSet("nonexistent")).toBeUndefined();
    });
  });

  describe("hasToolSet", () => {
    it("answers for a registered and an unregistered id", () => {
      expect(hasToolSet(SANDBOX_TOOLSET_ID)).toBe(true);
      expect(hasToolSet("nonexistent")).toBe(false);
    });
  });

  describe("registerToolSet", () => {
    const composed = (id: string, name: string) =>
      composeToolSet({
        id,
        pluginName: "test-plugin",
        isCore: false,
        plugin: makePluginContext(),
        contribution: {
          name,
          category: "Test",
          description: `${name} tools`,
          tools: {},
        },
      });

    it("keys on the tool-set id, so a duplicate is refused", () => {
      expect(() =>
        registerToolSet(SANDBOX_TOOLSET_ID, composed("dup", "Duplicate")),
      ).toThrow(
        `Tool set '${SANDBOX_TOOLSET_ID}' has already been registered.`,
      );
    });

    it("registers a new tool set and returns it with its id folded in", () => {
      const set = registerToolSet(
        "test-only-set",
        composed("test-only-set", "Test Only"),
      );
      expect(set.id).toBe("test-only-set");
      expect(getToolSet("test-only-set")).toBe(set);
    });
  });
});

describe("composeToolSet", () => {
  const ctx = {
    orgId: "org-1",
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
    frontendUrl: "http://localhost:3000",
    timezone: "UTC",
    sessionId: "chat-1",
    registerCloser: () => {},
  };

  const compose = (
    tools: ToolSetContribution["tools"],
    pluginName = "acme",
    isCore = false,
  ) =>
    composeToolSet({
      id: isCore ? "widgets" : "acme.widgets",
      pluginName,
      isCore,
      plugin: makePluginContext(),
      contribution: {
        name: "Widgets",
        category: "Test",
        description: "Test set",
        tools,
      },
    });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves no tools — rather than failing the turn — when the factory throws", async () => {
    const registration = compose(() => {
      throw new Error("no API key");
    });

    await expect(
      registration.buildTurnTools(ctx, undefined, () => {}),
    ).resolves.toEqual({});
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: "acme", toolSet: "acme.widgets" }),
      expect.stringContaining("Tool set factory threw"),
    );
  });

  it("hands every turn a registrar, so an unguarded call is not a fault", async () => {
    const registration = compose((ctx) => {
      ctx.registerCloser(() => {});
      return { widget: { description: "w" } as unknown as Tool };
    });

    await expect(
      registration.buildTurnTools(ctx, undefined, () => {}),
    ).resolves.toHaveProperty("acme__widget");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("serves no tools when a factory resolves to something that is not a tool map", async () => {
    const registration = compose(
      () => "oops" as unknown as Record<string, Tool>,
    );

    await expect(
      registration.buildTurnTools(ctx, undefined, () => {}),
    ).resolves.toEqual({});
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: "acme", toolSet: "acme.widgets" }),
      expect.stringContaining("no tool map"),
    );
  });

  describe("reporting a failed factory (issue #1184)", () => {
    it.each<[string, ToolSetContribution["tools"]]>([
      [
        "throws",
        () => {
          throw new Error("no API key");
        },
      ],
      ["returns no tool map", () => "oops" as unknown as Record<string, Tool>],
    ])("reports a factory that %s", async (_label, tools) => {
      const onFactoryFailed = vi.fn();

      await compose(tools).buildTurnTools(ctx, undefined, onFactoryFailed);

      expect(onFactoryFailed).toHaveBeenCalledTimes(1);
    });

    it("does not report a factory that serves no tools on purpose", async () => {
      const onFactoryFailed = vi.fn();

      await compose(() => ({})).buildTurnTools(ctx, undefined, onFactoryFailed);

      expect(onFactoryFailed).not.toHaveBeenCalled();
    });

    it("does not report a factory abandoned because the run was cancelled", async () => {
      const onFactoryFailed = vi.fn();
      const run = new AbortController();

      const building = compose(() => new Promise(() => {})).buildTurnTools(
        ctx,
        run.signal,
        onFactoryFailed,
      );
      run.abort(new Error("cancelled"));
      await building;

      expect(onFactoryFailed).not.toHaveBeenCalled();
    });
  });

  it("normalizes every tool's result, with no observability wrapper in play", async () => {
    const createdAt = new Date("2026-08-06T00:00:00.000Z");
    const registration = compose({
      listBoards: {
        execute: () => Promise.resolve([{ id: "b1", createdAt }]),
      } as unknown as Tool,
      now: { execute: () => ({ at: createdAt }) } as unknown as Tool,
    });

    const tools = await registration.buildTurnTools(ctx, undefined, () => {});
    const exec = (name: string) =>
      (
        tools[namespaceToolName("acme", name)] as unknown as {
          execute: (a: unknown, o: unknown) => unknown;
        }
      ).execute({}, {});

    await expect(exec("listBoards")).resolves.toEqual([
      { id: "b1", createdAt: createdAt.toISOString() },
    ]);
    expect(exec("now")).toEqual({ at: createdAt.toISOString() });
  });

  it("leaves a tool with no execute function alone", async () => {
    const bare = { description: "no execute" } as unknown as Tool;
    const tools = await compose({ bare }).buildTurnTools(
      ctx,
      undefined,
      () => {},
    );
    expect(tools.acme__bare).toBe(bare);
  });

  it("binds the plugin's deploy-time config into the factory", async () => {
    const tools = vi.fn().mockResolvedValue({});
    const plugin = makePluginContext({ config: { region: "eu" } });
    await composeToolSet({
      id: "acme.widgets",
      pluginName: "acme",
      isCore: false,
      plugin,
      contribution: {
        name: "Widgets",
        category: "Test",
        description: "Test set",
        tools,
      },
    }).buildTurnTools(ctx, undefined, () => {});

    expect(tools).toHaveBeenCalledWith(
      { ...ctx, registerCloser: expect.any(Function) as unknown },
      plugin,
    );
  });

  it("exposes a static map to the catalogs, and a factory's tools not at all", () => {
    const staticTool = { description: "static" } as unknown as Tool;
    expect(compose({ staticTool }).staticTools).toEqual({
      acme__staticTool: staticTool,
    });
    expect(compose(() => ({})).staticTools).toBeUndefined();
  });
});

describe("composeToolSet tool-name namespacing", () => {
  const ctx = {
    orgId: "org-1",
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
    frontendUrl: "http://localhost:3000",
    timezone: "UTC",
    sessionId: "chat-1",
    registerCloser: () => {},
  };

  const stub = (description: string) => ({ description }) as unknown as Tool;

  const compose = (
    tools: ToolSetContribution["tools"],
    { pluginName = "acme", isCore = false } = {},
  ) =>
    composeToolSet({
      id: isCore ? "widgets" : `${pluginName}.widgets`,
      pluginName,
      isCore,
      plugin: makePluginContext(),
      contribution: {
        name: "Widgets",
        category: "Test",
        description: "Test set",
        tools,
      },
    });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("namespaces a third-party set's tool names under its manifest name", async () => {
    const tools = await compose({
      createIssue: stub("a"),
      listIssues: stub("b"),
    }).buildTurnTools(ctx, undefined, () => {});

    expect(Object.keys(tools).sort()).toEqual([
      "acme__createIssue",
      "acme__listIssues",
    ]);
  });

  it("leaves a core set's tool names bare", async () => {
    const tools = await compose(
      { convertWeight: stub("a") },
      { pluginName: CORE_BUILTIN_OWNER, isCore: true },
    ).buildTurnTools(ctx, undefined, () => {});

    expect(Object.keys(tools)).toEqual(["convertWeight"]);
  });

  it("does not leave names bare for a third-party set that borrows core's owner name", async () => {
    const tools = await compose(() => ({ convertWeight: stub("a") }), {
      pluginName: CORE_BUILTIN_OWNER,
      isCore: false,
    }).buildTurnTools(ctx, undefined, () => {});

    expect(tools).not.toHaveProperty("convertWeight");
  });

  it("namespaces on every turn, whether or not anything collides", async () => {
    const tools = await compose({ createIssue: stub("a") }).buildTurnTools(
      ctx,
      undefined,
      () => {},
    );
    expect(tools).toHaveProperty("acme__createIssue");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps a Tool set's own web_search rather than losing it to core's", async () => {
    const tools = await compose({
      [WEB_SEARCH_TOOL_NAME]: stub("the plugin's own search"),
    }).buildTurnTools(ctx, undefined, () => {});

    expect(Object.keys(tools)).toEqual(["acme__web_search"]);
  });

  it("prefixes a name that already contains the separator, rather than stripping it", async () => {
    const tools = await compose({
      github__pull: stub("a"),
    }).buildTurnTools(ctx, undefined, () => {});

    expect(Object.keys(tools)).toEqual(["acme__github__pull"]);
  });

  it("gives two plugins contributing one tool name distinct names, dropping neither", async () => {
    const first = await compose({ createIssue: stub("a") }).buildTurnTools(
      ctx,
      undefined,
      () => {},
    );
    const second = await compose(
      { createIssue: stub("b") },
      { pluginName: "globex" },
    ).buildTurnTools(ctx, undefined, () => {});

    expect(Object.keys(first)).toEqual(["acme__createIssue"]);
    expect(Object.keys(second)).toEqual(["globex__createIssue"]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  describe("the tool-name cap", () => {
    const overCap = "x".repeat(MAX_PLUGIN_TOOL_NAME_LENGTH + 1);

    it("fails boot for a static map over the cap, naming what an author must fix", () => {
      let thrown = "";
      try {
        compose({ [overCap]: stub("a") });
      } catch (error) {
        thrown = (error as Error).message;
      }
      for (const fragment of [
        'Plugin "acme"',
        'tool set "acme.widgets"',
        overCap,
        `${MAX_PLUGIN_TOOL_NAME_LENGTH}-character cap`,
        `${overCap.length} characters`,
      ]) {
        expect(thrown).toContain(fragment);
      }
    });

    it("excludes and warns for a factory-resolved name over the cap, keeping the rest", async () => {
      const tools = await compose(() => ({
        [overCap]: stub("a"),
        createIssue: stub("b"),
      })).buildTurnTools(ctx, undefined, () => {});

      expect(Object.keys(tools)).toEqual(["acme__createIssue"]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          plugin: "acme",
          toolSet: "acme.widgets",
          tool: overCap,
          cap: MAX_PLUGIN_TOOL_NAME_LENGTH,
          length: overCap.length,
        }),
        expect.stringContaining("Excluding it"),
      );
    });

    it("holds a core set to no cap, since its names are not namespaced", async () => {
      const tools = await compose(
        { [overCap]: stub("a") },
        { pluginName: CORE_BUILTIN_OWNER, isCore: true },
      ).buildTurnTools(ctx, undefined, () => {});
      expect(Object.keys(tools)).toEqual([overCap]);
    });
  });

  describe("the tool-name character rule", () => {
    it("fails boot for a static name a model provider could not call", () => {
      let thrown = "";
      try {
        compose({ "has.a.dot": stub("a") });
      } catch (error) {
        thrown = (error as Error).message;
      }
      expect(thrown).toContain('"has.a.dot"');
      expect(thrown).toContain("letters, digits, underscores and hyphens");
      expect(thrown).not.toContain("[a-zA-Z0-9_-]");
    });

    it("reports a factory-resolved one without claiming the cap was the reason", async () => {
      const tools = await compose(() => ({
        "has.a.dot": stub("a"),
      })).buildTurnTools(ctx, undefined, () => {});

      expect(tools).toEqual({});
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          plugin: "acme",
          toolSet: "acme.widgets",
          tool: "has.a.dot",
          namespacedName: "acme__has.a.dot",
        }),
        expect.stringContaining("letters, digits, underscores and hyphens"),
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ cap: MAX_PLUGIN_TOOL_NAME_LENGTH }),
        expect.anything(),
      );
    });
  });

  describe("the reserved core turn-tool names", () => {
    it.each(RESERVED_TURN_TOOL_NAMES)(
      "fails boot when a core Tool set statically declares %s",
      (reserved) => {
        let thrown = "";
        try {
          compose(
            { [reserved]: stub("a") },
            { pluginName: CORE_BUILTIN_OWNER, isCore: true },
          );
        } catch (error) {
          thrown = (error as Error).message;
        }
        for (const fragment of [
          `Plugin "${CORE_BUILTIN_OWNER}"`,
          'tool set "widgets"',
          `"${reserved}"`,
        ]) {
          expect(thrown).toContain(fragment);
        }
      },
    );

    it("lets a core Tool set declare any other name", () => {
      expect(() =>
        compose(
          { loadSkills: stub("a") },
          { pluginName: CORE_BUILTIN_OWNER, isCore: true },
        ),
      ).not.toThrow();
    });

    it("cannot see a core factory's names, and does not pretend to", async () => {
      const registration = compose(
        () => ({ [LOAD_SKILL_TOOL_NAME]: stub("a") }),
        {
          pluginName: CORE_BUILTIN_OWNER,
          isCore: true,
        },
      );
      await expect(
        registration.buildTurnTools(ctx, undefined, () => {}),
      ).resolves.toHaveProperty(LOAD_SKILL_TOOL_NAME);
    });

    it("lets a third-party Tool set declare one, because it can no longer produce it bare", async () => {
      const tools = await compose({
        [LOAD_SKILL_TOOL_NAME]: stub("a"),
      }).buildTurnTools(ctx, undefined, () => {});
      expect(Object.keys(tools)).toEqual([`acme__${LOAD_SKILL_TOOL_NAME}`]);
    });
  });
});

describe("the sandbox tool set", () => {
  const turn = {
    orgId: "org-1",
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
    frontendUrl: "http://localhost:3000",
    timezone: "UTC",
    sessionId: "chat-1",
    registerCloser: () => {},
  };
  const shellExec = vi.fn();
  const create = vi.fn(() => ({ shellExec }) as unknown as SandboxBackend);

  const sandboxRow = (over: Record<string, unknown> = {}) => ({
    id: "sb-1",
    workspaceId: "ws-1",
    backend: "test-backend",
    config: { image: "node" },
    credentials: { token: "secret" },
    userEnv: {},
    adminEnv: {},
    ...over,
  });

  const build = () =>
    getToolSet(SANDBOX_TOOLSET_ID)!.buildTurnTools(turn, undefined, () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    clearSandboxBackends();
    registerSandboxBackend({
      backend: "test-backend",
      name: "Test",
      configSchema: z.object({ image: z.string() }),
      credentialsSchema: z.object({ token: z.string() }),
      create,
    });
    shellExec.mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
      truncated: false,
      durationMs: 0,
    });
  });

  it("builds the adapter from the workspace's validated config and credentials", async () => {
    seedDb({ sandbox: [sandboxRow()] });

    const tools = await build();

    expect(Object.keys(tools).sort()).toEqual([
      "fsEdit",
      "fsList",
      "fsRead",
      "fsWrite",
      "shellExec",
    ]);
    expect(create).toHaveBeenCalledWith({ image: "node" }, { token: "secret" });
  });

  it("merges the workspace env over the model's, the admin tier winning", async () => {
    seedDb({
      sandbox: [
        sandboxRow({
          userEnv: { SHARED: "user", USER_ONLY: "user" },
          adminEnv: { SHARED: "admin" },
        }),
      ],
    });
    const tools = await build();

    const abortSignal = new AbortController().signal;
    await callTool(
      tools.shellExec,
      { command: "env", env: { SHARED: "model", USER_ONLY: "model", M: "1" } },
      { toolCallId: "t", messages: [], context: undefined, abortSignal },
    );

    expect(shellExec).toHaveBeenCalledWith(
      { orgId: "org-1", workspaceId: "ws-1", userId: "user-1" },
      {
        command: "env",
        env: { SHARED: "admin", USER_ONLY: "user", M: "1" },
      },
      { signal: abortSignal },
    );
  });

  it("closes the turn's adapter when the turn ends", async () => {
    seedDb({ sandbox: [sandboxRow()] });
    const close = vi.fn(() => Promise.resolve());
    create.mockReturnValueOnce({
      shellExec,
      close,
    } as unknown as SandboxBackend);
    const closers: (() => Promise<void> | void)[] = [];

    await getToolSet(SANDBOX_TOOLSET_ID)!.buildTurnTools(
      {
        ...turn,
        registerCloser: (fn) => closers.push(fn),
      },
      undefined,
      () => {},
    );
    expect(close).not.toHaveBeenCalled();

    for (const fn of closers) await fn();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("serves nothing when this workspace has no sandbox, even if another does", async () => {
    seedDb({ sandbox: [sandboxRow({ workspaceId: "ws-2" })] });

    expect(await build()).toEqual({});
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the backend is not registered",
      { backend: "gone" },
      "Sandbox backend not registered; skipping sandbox tools for this turn",
    ],
    [
      "the config fails the adapter's schema",
      { config: { image: 1 } },
      "Sandbox config failed adapter validation; skipping sandbox tools",
    ],
    [
      "the credentials fail the adapter's schema",
      { credentials: {} },
      "Sandbox credentials failed adapter validation; skipping sandbox tools",
    ],
  ])("serves nothing and warns when %s", async (_label, over, message) => {
    seedDb({ sandbox: [sandboxRow(over)] });

    expect(await build()).toEqual({});
    expect(create).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "sb-1", plugin: null }),
      message,
    );
  });
});
