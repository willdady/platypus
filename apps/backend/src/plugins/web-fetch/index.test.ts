import { describe, it, expect } from "vitest";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import { plugin } from "./index.ts";
import { loadPlugins } from "../loader.ts";
import { getToolSet, getToolSets } from "../../tools/index.ts";

describe("@platypus/web-fetch plugin manifest", () => {
  it("declares its identity and API version", () => {
    expect(plugin.name).toBe("@platypus/web-fetch");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it("contributes the web-fetch tool set with the unprefixed core id", () => {
    const ids = (plugin.contributes.toolSets ?? []).map((t) => t.id);
    expect(ids).toEqual(["web-fetch"]);
  });

  it("declares a plugin-level configSchema (ignoreRobotsTxt, deploy-time)", () => {
    expect(plugin.configSchema).toBeDefined();
    // Defaults to robots.txt-respecting when the Operator supplies nothing.
    expect(plugin.configSchema?.parse({})).toEqual({ ignoreRobotsTxt: false });
    expect(plugin.configSchema?.parse({ ignoreRobotsTxt: true })).toEqual({
      ignoreRobotsTxt: true,
    });
  });

  it("exposes web-fetch as a config-driven tool factory yielding fetchUrl", () => {
    const [webFetch] = plugin.contributes.toolSets ?? [];
    expect(typeof webFetch.tools).toBe("function");
    if (typeof webFetch.tools !== "function")
      throw new Error("expected factory");
    const tools = webFetch.tools(
      {
        workspaceId: "w",
        agentId: "a",
        orgId: "o",
        frontendUrl: undefined,
        userId: "u",
      },
      { config: { ignoreRobotsTxt: false }, credentials: undefined },
    );
    expect(tools).toHaveProperty("fetchUrl");
  });

  it("registers the web-fetch tool set into the core registry when loaded", async () => {
    // The registry is module-global; vitest isolates modules per file, so this
    // load doesn't leak into other test files. Exercise the real plugin path:
    // loader → registerToolSet → getToolSet.
    expect(getToolSets()).not.toHaveProperty("web-fetch");

    const loaded = await loadPlugins({ pluginNames: ["@platypus/web-fetch"] });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      name: "@platypus/web-fetch",
      origin: "core",
      toolSetIds: ["web-fetch"],
    });

    const set = getToolSet("web-fetch");
    expect(set.name).toBe("Web Fetch");
    expect(set.category).toBe("Web");
    // The loader binds the plugin config into a factory; resolving it (as a Chat
    // turn would) yields the fetchUrl tool.
    expect(typeof set.tools).toBe("function");
    if (typeof set.tools !== "function") throw new Error("expected factory");
    const tools = await set.tools({
      workspaceId: "w",
      agentId: "a",
      orgId: "o",
      frontendUrl: undefined,
      userId: "u",
    });
    expect(tools).toHaveProperty("fetchUrl");
  });
});
