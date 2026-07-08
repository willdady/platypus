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

  it("exposes fetchUrl as a static tool map", () => {
    const [webFetch] = plugin.contributes.toolSets ?? [];
    expect(typeof webFetch.tools).not.toBe("function");
    expect(webFetch.tools).toHaveProperty("fetchUrl");
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
    expect(set.tools).toHaveProperty("fetchUrl");
  });
});
