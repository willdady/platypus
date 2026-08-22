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
  composeToolSet,
  getToolSets,
  getToolSet,
  hasToolSet,
  registerToolSet,
  SANDBOX_TOOLSET_ID,
} from "./index.ts";
import { logger } from "../logger.ts";

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

  const compose = (tools: ToolSetContribution["tools"], pluginName = "acme") =>
    composeToolSet({
      id: "acme.widgets",
      pluginName,
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
        tools[name] as unknown as {
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
    expect(tools.bare).toBe(bare);
  });

  it("names both plugins when it takes a tool name an earlier tool set claimed", async () => {
    const claimed = new Map([
      ["search", { toolSetId: "other.set", plugin: "other" }],
    ]);

    const tools = await compose({
      search: { execute: () => ({}) } as unknown as Tool,
    }).buildTurnTools(ctx, claimed);

    // The later one still wins — assignment order is the precedence order — but
    // the swap is no longer silent.
    expect(tools).toHaveProperty("search");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "search",
        plugin: "acme",
        shadowedToolSet: "other.set",
        shadowedPlugin: "other",
      }),
      expect.stringContaining("same tool name"),
    );
  });

  it("says nothing when no name is contested", async () => {
    const claimed = new Map([
      ["listBoards", { toolSetId: "other.set", plugin: "other" }],
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
      plugin,
      contribution: { name: "Widgets", category: "Test", tools },
    }).buildTurnTools(ctx);

    expect(tools).toHaveBeenCalledWith(ctx, plugin);
  });

  it("exposes a static map to the catalogs, and a factory's tools not at all", () => {
    const staticTool = { description: "static" } as unknown as Tool;
    expect(compose({ staticTool }).staticTools).toEqual({ staticTool });
    expect(compose(() => ({})).staticTools).toBeUndefined();
  });
});
