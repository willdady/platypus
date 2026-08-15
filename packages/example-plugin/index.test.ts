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
};

// Resolve the tool set the way core does at Chat-turn time: the factory, the
// runtime scope, and the plugin's deploy-time block (optional to consume).
const resolveTools = async (pluginCtx?: PluginConfigContext) => {
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
      { toolCallId: "t1", messages: [] },
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

    await resolveTools({ config: undefined, credentials: undefined, logger });

    // Structured fields, not an interpolated string: they stay queryable in the
    // Operator's log pipeline. The plugin's name is NOT among them — core binds
    // that onto the child logger, so an author never repeats it.
    expect(logger.debug).toHaveBeenCalledWith(
      { workspaceId: "ws-1", agentId: "agent-1" },
      expect.any(String),
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("resolves on a core that supplies no logger (both are optional)", async () => {
    // The append-only contract in practice: `logger` arrived after this SDK's
    // first release, so the plugin must still resolve where it is absent.
    await expect(
      resolveTools({ config: undefined, credentials: undefined }),
    ).resolves.toHaveProperty("greet");
    await expect(resolveTools()).resolves.toHaveProperty("greet");
  });
});
