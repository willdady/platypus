import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Tool } from "ai";
import type { ToolSetContribution } from "@platypuschat/plugin-sdk";

// Mock the db used by transitive imports (the sandbox tool set, etc.)
vi.mock("../index.ts", () => ({
  db: {},
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../services/event-dispatch.ts", () => ({
  dispatchEvent: vi.fn(),
}));

vi.mock("../services/sub-agent-validation.ts", () => ({
  validateSubAgentAssignment: vi.fn(),
}));

vi.mock("../storage/index.ts", () => ({
  getStorage: vi.fn(),
}));

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

// The store's own contract — miss semantics, duplicate rejection, prototype-key
// safety, listing, reset — is covered once in
// `registry/contribution-registry.test.ts`. What is left here is what this
// instance adds: the id it keys on, and what registers at import time.
describe("Tool Set Registry", () => {
  const registeredIds = () => getToolSets().map((s) => s.id);

  describe("getToolSets", () => {
    it("returns the statically-registered tool sets", () => {
      expect(registeredIds().length).toBeGreaterThan(0);
    });

    it("no longer statically registers the plugin-migrated tool sets", () => {
      // Every native Tool set now ships as a core plugin loaded via the plugin
      // loader (ADR-0013): `math-conversions`/`time` → @platypus/tools-basic,
      // `web-fetch` → @platypus/web-fetch, and the Platypus-domain sets →
      // @platypus/tools-platform. None register at import time here anymore.
      for (const id of [
        "math-conversions",
        "time",
        "web-fetch",
        "kanban",
        "dashboards",
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
      // The `sandbox` set is the consumer side of the Sandbox-backend extension
      // point (ADR-0002), not a native Tool set, so it stays a core-internal
      // static registration — the lone one left in tools/index.ts.
      expect(registeredIds()).toContain(SANDBOX_TOOLSET_ID);
    });
  });

  describe("getToolSet", () => {
    it("returns the sandbox tool set by id", () => {
      const set = getToolSet(SANDBOX_TOOLSET_ID)!;
      expect(set).toBeDefined();
      expect(set.name).toBe("Sandbox");
      expect(set.category).toBe("Sandbox");
      // What the registry holds is core's composed builder, never the raw
      // factory — the same shape a plugin's contribution is stored as.
      expect(typeof set.buildTurnTools).toBe("function");
      expect(set.staticTools).toBeUndefined();
    });

    it("returns undefined for an unregistered id", () => {
      // Chat-turn resolution reads this `undefined` as "not a static tool set,
      // try MCP", so the miss is a value here rather than an exception.
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
        contribution: { name, category: "Test", tools: {} },
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

// What core owns between a plugin's factory and the model (ADR-0013), and the
// mirror of `composeWebBackend`'s coverage in `web-backends/index.test.ts`.
describe("composeToolSet", () => {
  const ctx = {
    orgId: "org-1",
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
    frontendUrl: undefined,
  };

  // Third-party by default, which is the interesting origin: its tool names are
  // namespaced under the manifest name (issue #664).
  const compose = (
    tools: ToolSetContribution["tools"],
    pluginName = "acme",
    isCore = false,
  ) =>
    composeToolSet({
      id: isCore ? "widgets" : "acme.widgets",
      pluginName,
      isCore,
      contribution: { name: "Widgets", category: "Test", tools },
    });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves no tools — rather than failing the turn — when the factory throws", async () => {
    const registration = compose(() => {
      throw new Error("no API key");
    });

    await expect(registration.buildTurnTools(ctx)).resolves.toEqual({});
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: "acme", toolSet: "acme.widgets" }),
      expect.stringContaining("Tool set factory threw"),
    );
  });

  // The Tool-set half of the version-skew guarantee the Web-search side pins in
  // `web-backends/index.test.ts`. `ctx` above carries no `registerCloser`, which
  // is exactly what a factory compiled against a newer SDK meets on an older
  // core — the member is optional precisely so this is a guarded call.
  it("serves no tools when a factory calls the registrar unguarded on an older core", async () => {
    const registration = compose((ctx) => {
      // The `!` this contract's docs tell an author never to write. On a core
      // without the member it is a TypeError out of the factory.
      ctx.registerCloser!(() => {});
      return {};
    });

    await expect(registration.buildTurnTools(ctx)).resolves.toEqual({});
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: "acme", toolSet: "acme.widgets" }),
      expect.stringContaining("Tool set factory threw"),
    );
  });

  it("serves no tools when a factory resolves to something that is not a tool map", async () => {
    const registration = compose(
      () => "oops" as unknown as Record<string, Tool>,
    );

    await expect(registration.buildTurnTools(ctx)).resolves.toEqual({});
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: "acme", toolSet: "acme.widgets" }),
      expect.stringContaining("no tool map"),
    );
  });

  // #321: a raw Drizzle `Date` fails the next step's prompt validation. The
  // guarantee used to hold only when the turn supplied an `onActivity` callback.
  it("normalizes every tool's result, with no observability wrapper in play", async () => {
    const createdAt = new Date("2026-08-06T00:00:00.000Z");
    const registration = compose({
      listBoards: {
        execute: () => Promise.resolve([{ id: "b1", createdAt }]),
      } as unknown as Tool,
      now: { execute: () => ({ at: createdAt }) } as unknown as Tool,
    });

    const tools = await registration.buildTurnTools(ctx);
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
    const tools = await compose({ bare }).buildTurnTools(ctx);
    expect(tools.acme__bare).toBe(bare);
  });

  it("names both plugins when it takes a tool name an earlier tool set claimed", async () => {
    // Keyed on the *namespaced* name, because that is the name the turn's map
    // holds and the only name two Tool sets can now contest.
    const claimed = new Map([
      ["acme__search", { toolSetId: "other.set", plugin: "other" }],
    ]);

    const tools = await compose({
      search: { execute: () => ({}) } as unknown as Tool,
    }).buildTurnTools(ctx, claimed);

    // The later one still wins — assignment order is the precedence order — but
    // the swap is no longer silent.
    expect(tools).toHaveProperty("acme__search");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "acme__search",
        plugin: "acme",
        shadowedToolSet: "other.set",
        shadowedPlugin: "other",
      }),
      expect.stringContaining("same tool name"),
    );
  });

  it("says nothing when no name is contested", async () => {
    const claimed = new Map([
      ["acme__listBoards", { toolSetId: "other.set", plugin: "other" }],
    ]);

    await compose({
      search: { execute: () => ({}) } as unknown as Tool,
    }).buildTurnTools(ctx, claimed);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("binds the plugin's deploy-time config into the factory", async () => {
    const tools = vi.fn().mockResolvedValue({});
    const plugin = { config: { region: "eu" }, credentials: undefined };
    await composeToolSet({
      id: "acme.widgets",
      pluginName: "acme",
      isCore: false,
      plugin,
      contribution: { name: "Widgets", category: "Test", tools },
    }).buildTurnTools(ctx);

    expect(tools).toHaveBeenCalledWith(ctx, plugin);
  });

  it("exposes a static map to the catalogs, and a factory's tools not at all", () => {
    const staticTool = { description: "static" } as unknown as Tool;
    // Namespaced, because the Tool-set listing screens must show the names the
    // model will actually call.
    expect(compose({ staticTool }).staticTools).toEqual({
      acme__staticTool: staticTool,
    });
    expect(compose(() => ({})).staticTools).toBeUndefined();
  });
});

// Issue #664: core assigns `web_search`, `read_url`, `delegate` and `loadSkill`
// onto the turn's tool map *after* the Tool session, each by plain assignment.
// A Tool set that contributed one of those names lost it silently. Namespacing a
// third-party set's tool names removes the reachable case; a core set declaring
// one is refused at boot.
describe("composeToolSet tool-name namespacing", () => {
  const ctx = {
    orgId: "org-1",
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
    frontendUrl: undefined,
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
      contribution: { name: "Widgets", category: "Test", tools },
    });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("namespaces a third-party set's tool names under its manifest name", async () => {
    const tools = await compose({
      createIssue: stub("a"),
      listIssues: stub("b"),
    }).buildTurnTools(ctx);

    expect(Object.keys(tools).sort()).toEqual([
      "acme__createIssue",
      "acme__listIssues",
    ]);
  });

  it("leaves a core set's tool names bare", async () => {
    const tools = await compose(
      { convertWeight: stub("a") },
      { pluginName: CORE_BUILTIN_OWNER, isCore: true },
    ).buildTurnTools(ctx);

    expect(Object.keys(tools)).toEqual(["convertWeight"]);
  });

  it("namespaces on every turn, whether or not anything collides", async () => {
    // Nothing claimed, nothing contested — the name still changes, so it never
    // depends on the order an Agent's Tool sets happen to sit in.
    const tools = await compose({ createIssue: stub("a") }).buildTurnTools(
      ctx,
      new Map(),
    );
    expect(tools).toHaveProperty("acme__createIssue");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps a Tool set's own web_search rather than losing it to core's", async () => {
    const tools = await compose({
      [WEB_SEARCH_TOOL_NAME]: stub("the plugin's own search"),
    }).buildTurnTools(ctx);

    // What the Web-search stage would later assign is `web_search`; this is not
    // it, so the plain assignment has nothing of the Tool set's to overwrite.
    expect(Object.keys(tools)).toEqual(["acme__web_search"]);
  });

  it("prefixes a name that already contains the separator, rather than stripping it", async () => {
    const tools = await compose({
      github__pull: stub("a"),
    }).buildTurnTools(ctx);

    expect(Object.keys(tools)).toEqual(["acme__github__pull"]);
  });

  it("gives two plugins contributing one tool name distinct names, dropping neither", async () => {
    const first = await compose({ createIssue: stub("a") }).buildTurnTools(ctx);
    // The turn's map as the second set is shown it — the first set's tools,
    // already claimed.
    const claimed = new Map(
      Object.keys(first).map((name) => [
        name,
        { toolSetId: "acme.widgets", plugin: "acme" },
      ]),
    );
    const second = await compose(
      { createIssue: stub("b") },
      { pluginName: "globex" },
    ).buildTurnTools(ctx, claimed);

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
      // The plugin, the Tool set, the tool, the cap, and the actual length —
      // an author reading only the boot error has everything they need.
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
      })).buildTurnTools(ctx);

      // Never truncated to fit: two long names from one set could truncate onto
      // each other and reintroduce the collision invisibly.
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
      ).buildTurnTools(ctx);
      expect(Object.keys(tools)).toEqual([overCap]);
    });
  });

  // The other half of the name ceiling. The cap says nothing about characters,
  // and a model provider rejects a tool name carrying anything outside
  // `[a-zA-Z0-9_-]` — which a plugin can only reach through a quoted key, but
  // reaches all the same.
  describe("the tool-name character rule", () => {
    it("fails boot for a static name a model provider could not call", () => {
      let thrown = "";
      try {
        compose({ "has.a.dot": stub("a") });
      } catch (error) {
        thrown = (error as Error).message;
      }
      expect(thrown).toContain('"has.a.dot"');
      // A sentence, not the regex: the rule an author has to satisfy has to be
      // readable by the author.
      expect(thrown).toContain("letters, digits, underscores and hyphens");
      expect(thrown).not.toContain("[a-zA-Z0-9_-]");
    });

    it("reports a factory-resolved one without claiming the cap was the reason", async () => {
      const tools = await compose(() => ({
        "has.a.dot": stub("a"),
      })).buildTurnTools(ctx);

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
      // `cap` and `length` belong to the cap fault. Reporting them here would
      // name the wrong reason while the message named the right one.
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

    // Boot cannot see a factory's names, and core is first-party code under
    // review — the fault issue #664 reported was a third-party one.
    it("cannot see a core factory's names, and does not pretend to", async () => {
      const registration = compose(
        () => ({ [LOAD_SKILL_TOOL_NAME]: stub("a") }),
        {
          pluginName: CORE_BUILTIN_OWNER,
          isCore: true,
        },
      );
      await expect(registration.buildTurnTools(ctx)).resolves.toHaveProperty(
        LOAD_SKILL_TOOL_NAME,
      );
    });

    it("lets a third-party Tool set declare one, because it can no longer produce it bare", async () => {
      const tools = await compose({
        [LOAD_SKILL_TOOL_NAME]: stub("a"),
      }).buildTurnTools(ctx);
      expect(Object.keys(tools)).toEqual([`acme__${LOAD_SKILL_TOOL_NAME}`]);
    });
  });
});
