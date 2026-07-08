import { describe, it, expect, vi } from "vitest";
import type {
  PlatypusPlugin,
  ToolSetContribution,
} from "@platypuschat/plugin-sdk";
import { loadPlugins, parsePluginList } from "./loader.ts";

// A capturing `register` and the builtin/import module shapes the loader expects.
const makeRegister = () => {
  const calls: Array<{ id: string; def: Omit<ToolSetContribution, "id"> }> = [];
  const register = (id: string, def: Omit<ToolSetContribution, "id">) => {
    calls.push({ id, def });
  };
  return { register, calls };
};

const manifest = (
  name: string,
  toolSets: ToolSetContribution[],
): PlatypusPlugin => ({
  name,
  version: "0.1.0",
  apiVersion: 1,
  contributes: { toolSets },
});

const toolSet = (id: string): ToolSetContribution => ({
  id,
  name: id,
  category: "Test",
  tools: {},
});

describe("parsePluginList", () => {
  it("splits, trims, and drops blank entries", () => {
    expect(parsePluginList("a, b ,, c")).toEqual(["a", "b", "c"]);
  });

  it("returns an empty list for unset or empty input", () => {
    expect(parsePluginList(undefined)).toEqual([]);
    expect(parsePluginList("")).toEqual([]);
    expect(parsePluginList("  ")).toEqual([]);
  });
});

describe("loadPlugins", () => {
  it("loads a core plugin via the static built-in map", async () => {
    const { register, calls } = makeRegister();
    const builtinPlugins = {
      "@platypus/tools-basic": () =>
        Promise.resolve({
          plugin: manifest("@platypus/tools-basic", [
            toolSet("math-conversions"),
            toolSet("time"),
          ]),
        }),
    };

    const loaded = await loadPlugins({
      pluginNames: ["@platypus/tools-basic"],
      builtinPlugins,
      register,
    });

    expect(calls.map((c) => c.id)).toEqual(["math-conversions", "time"]);
    expect(loaded).toEqual([
      {
        name: "@platypus/tools-basic",
        version: "0.1.0",
        origin: "core",
        toolSetIds: ["math-conversions", "time"],
      },
    ]);
  });

  it("registers nothing for an empty list and does not crash", async () => {
    const { register, calls } = makeRegister();
    const loaded = await loadPlugins({
      pluginNames: [],
      builtinPlugins: {},
      register,
    });
    expect(loaded).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("resolves a third-party plugin via dynamic import", async () => {
    const { register, calls } = makeRegister();
    const importPlugin = vi.fn((_name: string) =>
      Promise.resolve({
        plugin: manifest("@third/party", [toolSet("custom")]),
      }),
    );

    const loaded = await loadPlugins({
      pluginNames: ["@third/party"],
      builtinPlugins: {},
      importPlugin,
      register,
    });

    expect(importPlugin).toHaveBeenCalledWith("@third/party");
    expect(calls.map((c) => c.id)).toEqual(["custom"]);
    expect(loaded[0].origin).toBe("third-party");
  });

  it("exercises both resolution paths in one load", async () => {
    const { register, calls } = makeRegister();
    const builtinPlugins = {
      "@platypus/tools-basic": () =>
        Promise.resolve({
          plugin: manifest("@platypus/tools-basic", [toolSet("time")]),
        }),
    };
    const importPlugin = vi.fn((_name: string) =>
      Promise.resolve({
        plugin: manifest("@third/party", [toolSet("custom")]),
      }),
    );

    const loaded = await loadPlugins({
      pluginNames: ["@platypus/tools-basic", "@third/party"],
      builtinPlugins,
      importPlugin,
      register,
    });

    expect(importPlugin).toHaveBeenCalledTimes(1);
    expect(importPlugin).toHaveBeenCalledWith("@third/party");
    expect(calls.map((c) => c.id)).toEqual(["time", "custom"]);
    expect(loaded.map((p) => p.origin)).toEqual(["core", "third-party"]);
  });

  it("aborts (fail-loud) when a plugin cannot be resolved", async () => {
    const { register } = makeRegister();
    const importPlugin = vi.fn(() => {
      throw new Error("Cannot find module");
    });

    await expect(
      loadPlugins({
        pluginNames: ["@missing/plugin"],
        builtinPlugins: {},
        importPlugin,
        register,
      }),
    ).rejects.toThrow(/@missing\/plugin.*failed to resolve/s);
  });

  it("aborts (fail-loud) on a manifest missing contributes", async () => {
    const { register } = makeRegister();
    await expect(
      loadPlugins({
        pluginNames: ["@bad/plugin"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({
            plugin: { name: "@bad/plugin", version: "0.1.0", apiVersion: 1 },
          }),
        register,
      }),
    ).rejects.toThrow(/@bad\/plugin.*contributes/s);
  });

  it("aborts (fail-loud) on a non-numeric apiVersion", async () => {
    const { register } = makeRegister();
    await expect(
      loadPlugins({
        pluginNames: ["@bad/plugin"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({
            plugin: {
              name: "@bad/plugin",
              version: "0.1.0",
              apiVersion: "1",
              contributes: {},
            },
          }),
        register,
      }),
    ).rejects.toThrow(/@bad\/plugin.*apiVersion/s);
  });

  it("aborts (fail-loud) when a module exports no manifest", async () => {
    const { register } = makeRegister();
    await expect(
      loadPlugins({
        pluginNames: ["@empty/plugin"],
        builtinPlugins: {},
        importPlugin: () => Promise.resolve({}),
        register,
      }),
    ).rejects.toThrow(/@empty\/plugin.*manifest/s);
  });

  it("aborts (fail-loud) on a duplicate id, naming both owning plugins", async () => {
    const { register } = makeRegister();
    const importPlugin = vi.fn((name: string) =>
      Promise.resolve({
        plugin: manifest(name, [toolSet("time")]),
      }),
    );

    await expect(
      loadPlugins({
        pluginNames: ["@a/plugin", "@b/plugin"],
        builtinPlugins: {},
        importPlugin,
        register,
      }),
    ).rejects.toThrow(/"time".*"@a\/plugin".*"@b\/plugin"/s);
  });

  it("re-throws a legacy-registry collision with plugin attribution", async () => {
    // A `register` that rejects the id (as the real registry does for an
    // already-registered legacy tool set) surfaces with plugin attribution.
    const register = () => {
      throw new Error("Tool set with id 'kanban' has already been registered.");
    };
    await expect(
      loadPlugins({
        pluginNames: ["@collides/plugin"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({
            plugin: manifest("@collides/plugin", [toolSet("kanban")]),
          }),
        register,
      }),
    ).rejects.toThrow(/@collides\/plugin.*"kanban".*already been registered/s);
  });
});
