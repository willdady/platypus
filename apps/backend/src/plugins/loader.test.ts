import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  OLDEST_SUPPORTED_API_VERSION,
  PLUGIN_API_VERSION,
  type PlatypusPlugin,
  type SandboxBackend,
  type SandboxBackendContribution,
  type ToolSetContribution,
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

// A capturing `registerSandbox` for the Sandbox-backend extension point.
const makeSandboxRegister = () => {
  const calls: SandboxBackendContribution[] = [];
  const registerSandbox = (contribution: SandboxBackendContribution) => {
    calls.push(contribution);
  };
  return { registerSandbox, calls };
};

const manifest = (
  name: string,
  toolSets: ToolSetContribution[],
  apiVersion: number = PLUGIN_API_VERSION,
): PlatypusPlugin => ({
  name,
  version: "0.1.0",
  apiVersion,
  contributes: { toolSets },
});

const sandboxManifest = (
  name: string,
  sandboxBackends: SandboxBackendContribution[],
): PlatypusPlugin => ({
  name,
  version: "0.1.0",
  apiVersion: 1,
  contributes: { sandboxBackends },
});

const toolSet = (id: string): ToolSetContribution => ({
  id,
  name: id,
  category: "Test",
  tools: {},
});

const sandboxBackend = (backend: string): SandboxBackendContribution => ({
  backend,
  name: backend,
  configSchema: z.object({}),
  credentialsSchema: z.object({}),
  // The loader never invokes create(); a stub suffices.
  create: () => ({}) as unknown as SandboxBackend,
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

describe("loadPlugins — apiVersion compatibility window (N and N−1)", () => {
  it("accepts a plugin declaring exactly core's apiVersion", async () => {
    const { register, calls } = makeRegister();
    const loaded = await loadPlugins({
      pluginNames: ["@exact/plugin"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({
          plugin: manifest(
            "@exact/plugin",
            [toolSet("exact")],
            PLUGIN_API_VERSION,
          ),
        }),
      register,
    });
    expect(calls.map((c) => c.id)).toEqual(["exact"]);
    expect(loaded[0].name).toBe("@exact/plugin");
  });

  it("accepts a plugin on the previous major (N−1)", async () => {
    const { register, calls } = makeRegister();
    const loaded = await loadPlugins({
      pluginNames: ["@nminus1/plugin"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({
          plugin: manifest(
            "@nminus1/plugin",
            [toolSet("older")],
            OLDEST_SUPPORTED_API_VERSION,
          ),
        }),
      register,
    });
    expect(calls.map((c) => c.id)).toEqual(["older"]);
    expect(loaded[0].name).toBe("@nminus1/plugin");
  });

  it("rejects (fail-loud) a plugin needing a newer API than core provides", async () => {
    const { register } = makeRegister();
    await expect(
      loadPlugins({
        pluginNames: ["@future/plugin"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({
            plugin: manifest(
              "@future/plugin",
              [toolSet("future")],
              PLUGIN_API_VERSION + 1,
            ),
          }),
        register,
      }),
    ).rejects.toThrow(
      new RegExp(
        `@future/plugin.*needs API v${PLUGIN_API_VERSION + 1}.*core supports up to v${PLUGIN_API_VERSION}`,
        "s",
      ),
    );
  });

  it("rejects (fail-loud) a plugin targeting a dropped, older major", async () => {
    const { register } = makeRegister();
    await expect(
      loadPlugins({
        pluginNames: ["@ancient/plugin"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({
            plugin: manifest(
              "@ancient/plugin",
              [toolSet("ancient")],
              OLDEST_SUPPORTED_API_VERSION - 1,
            ),
          }),
        register,
      }),
    ).rejects.toThrow(
      new RegExp(
        `@ancient/plugin.*targets API v${OLDEST_SUPPORTED_API_VERSION - 1}.*below the oldest`,
        "s",
      ),
    );
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
        sandboxBackendIds: [],
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

describe("loadPlugins — sandbox backends", () => {
  it("registers a sandbox-backend contribution and reports its id", async () => {
    const { register } = makeRegister();
    const { registerSandbox, calls } = makeSandboxRegister();
    const loaded = await loadPlugins({
      pluginNames: ["@platypus/docker"],
      builtinPlugins: {
        "@platypus/docker": () =>
          Promise.resolve({
            plugin: sandboxManifest("@platypus/docker", [
              sandboxBackend("docker"),
            ]),
          }),
      },
      register,
      registerSandbox,
    });

    expect(calls.map((c) => c.backend)).toEqual(["docker"]);
    expect(loaded).toEqual([
      {
        name: "@platypus/docker",
        version: "0.1.0",
        origin: "core",
        toolSetIds: [],
        sandboxBackendIds: ["docker"],
      },
    ]);
  });

  it("aborts (fail-loud) on a duplicate sandbox backend id, naming both plugins", async () => {
    const { register } = makeRegister();
    const { registerSandbox } = makeSandboxRegister();
    const importPlugin = vi.fn((name: string) =>
      Promise.resolve({
        plugin: sandboxManifest(name, [sandboxBackend("docker")]),
      }),
    );

    await expect(
      loadPlugins({
        pluginNames: ["@a/plugin", "@b/plugin"],
        builtinPlugins: {},
        importPlugin,
        register,
        registerSandbox,
      }),
    ).rejects.toThrow(/"docker".*"@a\/plugin".*"@b\/plugin"/s);
  });

  it("re-throws a registry collision with plugin attribution", async () => {
    const { register } = makeRegister();
    const registerSandbox = () => {
      throw new Error("Sandbox backend 'docker' has already been registered.");
    };
    await expect(
      loadPlugins({
        pluginNames: ["@collides/plugin"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({
            plugin: sandboxManifest("@collides/plugin", [
              sandboxBackend("docker"),
            ]),
          }),
        register,
        registerSandbox,
      }),
    ).rejects.toThrow(/@collides\/plugin.*"docker".*already been registered/s);
  });

  it("aborts (fail-loud) when sandboxBackends is not an array", async () => {
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
              apiVersion: 1,
              contributes: { sandboxBackends: {} },
            },
          }),
        register,
        registerSandbox: () => {},
      }),
    ).rejects.toThrow(/@bad\/plugin.*sandboxBackends.*array/s);
  });
});
