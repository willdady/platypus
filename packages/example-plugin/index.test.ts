import { describe, it, expect, vi } from "vitest";
import {
  PLUGIN_API_VERSION,
  type PluginConfigContext,
  type ToolSetContext,
} from "@platypuschat/plugin-sdk";
import { plugin } from "./index.ts";

const CTX: ToolSetContext = {
  workspaceId: "ws-1",
  agentId: "agent-1",
  orgId: "org-1",
  frontendUrl: undefined,
  userId: "user-1",
  registerCloser: () => {},
};

const pluginContext = (
  over: Partial<PluginConfigContext> = {},
): PluginConfigContext => ({
  config: undefined,
  credentials: undefined,
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ...over,
});

// Resolve the tool set the way core does at Chat-turn time: the factory, the
// runtime scope, and the plugin's deploy-time block. Both arguments are
// required as of API v2, and core supplies both on every turn.
const resolveTools = async (
  pluginCtx: PluginConfigContext = pluginContext(),
) => {
  const toolSet = plugin.contributes.toolSets?.[0];
  if (!toolSet || typeof toolSet.tools !== "function") {
    throw new Error("expected a tool-set factory");
  }
  return await toolSet.tools(CTX, pluginCtx);
};

describe("@platypus-examples/tool-set", () => {
  it("exports a well-formed manifest with a short namespace name", () => {
    // The manifest `name` is the namespace the loader prefixes onto every
    // contribution id for a third-party plugin — kept short and bare ("example")
    // rather than the scoped package specifier.
    expect(plugin.name).toBe("example");
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(plugin.contributes.toolSets).toHaveLength(1);
  });

  it("contributes a bare (unprefixed) tool set id", () => {
    // Authors write bare ids; core prefixes at load. The package must NOT
    // pre-namespace its own ids.
    const toolSet = plugin.contributes.toolSets?.[0];
    expect(toolSet?.id).toBe("greeting");
    expect(toolSet).not.toBeUndefined();
  });

  it("greet returns a greeting for the given name", async () => {
    const tools = await resolveTools();
    const result = await tools.greet.execute!(
      { name: "Ada" },
      { toolCallId: "t1", messages: [], context: {} },
    );
    expect(result).toContain("Ada");
  });

  it("logs through the logger core puts on the plugin block", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await resolveTools(pluginContext({ logger }));

    // Structured fields, not an interpolated string: they stay queryable in the
    // Operator's log pipeline. The plugin's name is NOT among them — core binds
    // that onto the child logger, so an author never repeats it.
    expect(logger.debug).toHaveBeenCalledWith(
      { workspaceId: "ws-1", agentId: "agent-1" },
      expect.any(String),
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("declares the API major whose contract it reads unguarded", async () => {
    // The plugin reads `plugin.logger` and would read `ctx.registerCloser`
    // without a guard. Both are required from v2 on, so the manifest has to ask
    // for a core that supplies them — a v1 core refuses this plugin at boot
    // rather than letting it fail inside somebody's Chat turn.
    expect(plugin.apiVersion).toBeGreaterThanOrEqual(2);
    await expect(resolveTools()).resolves.toHaveProperty("greet");
  });
});
