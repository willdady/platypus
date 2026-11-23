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
    expect(plugin.configSchema.parse({})).toEqual({ ignoreRobotsTxt: false });
    expect(plugin.configSchema.parse({ ignoreRobotsTxt: true })).toEqual({
      ignoreRobotsTxt: true,
    });
  });

  it("registers the web-fetch tool set into the core registry when loaded", async () => {
    expect(getToolSets().map((s) => s.id)).not.toContain("web-fetch");

    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["@platypus/web-fetch"],
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      name: "@platypus/web-fetch",
      origin: "core",
      toolSetIds: ["web-fetch"],
    });

    const set = getToolSet("web-fetch")!;
    expect(set.name).toBe("Web Fetch");
    expect(set.category).toBe("Web");
    const tools = await set.buildTurnTools(
      {
        workspaceId: "w",
        agentId: "a",
        orgId: "o",
        frontendUrl: "http://localhost:3000",
        userId: "u",
        timezone: "UTC",
        sessionId: "chat-1",
        registerCloser: () => {},
      },
      undefined,
      () => {},
    );
    expect(tools).toHaveProperty("fetchUrl");
  });
});
