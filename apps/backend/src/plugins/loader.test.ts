import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type {
  PlatypusPlugin,
  SandboxBackend,
  SandboxBackendContribution,
  ToolSetContribution,
} from "@platypuschat/plugin-sdk";
import { loadPlugins, parsePluginList } from "./loader.ts";
import { registerToolSet, getToolSet } from "../tools/index.ts";

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
): PlatypusPlugin => ({
  name,
  version: "0.1.0",
  apiVersion: 1,
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
    // Third-party ids are auto-prefixed with the manifest name at load; authors
    // write the bare `custom`.
    expect(calls.map((c) => c.id)).toEqual(["@third/party.custom"]);
    expect(loaded[0].origin).toBe("third-party");
    expect(loaded[0].toolSetIds).toEqual(["@third/party.custom"]);
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
    // Core keeps its bare id; third-party is prefixed with its manifest name.
    expect(calls.map((c) => c.id)).toEqual(["time", "@third/party.custom"]);
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
    // Two core plugins keep bare ids, so a shared `time` id collides directly.
    const builtinPlugins = {
      "@a/plugin": () =>
        Promise.resolve({ plugin: manifest("@a/plugin", [toolSet("time")]) }),
      "@b/plugin": () =>
        Promise.resolve({ plugin: manifest("@b/plugin", [toolSet("time")]) }),
    };

    await expect(
      loadPlugins({
        pluginNames: ["@a/plugin", "@b/plugin"],
        builtinPlugins,
        register,
      }),
    ).rejects.toThrow(/"time".*"@a\/plugin".*"@b\/plugin"/s);
  });

  it("aborts (fail-loud) when two third-party plugins share a manifest name and id", async () => {
    const { register } = makeRegister();
    // Both packages resolve to a manifest named "dup", so their bare `custom`
    // ids both namespace to `dup.custom` and collide.
    const importPlugin = vi.fn(() =>
      Promise.resolve({ plugin: manifest("dup", [toolSet("custom")]) }),
    );

    await expect(
      loadPlugins({
        pluginNames: ["@a/pkg", "@b/pkg"],
        builtinPlugins: {},
        importPlugin,
        register,
      }),
    ).rejects.toThrow(/"dup\.custom".*"dup".*"dup"/s);
  });

  it("re-throws a legacy-registry collision with plugin attribution", async () => {
    // A `register` that rejects the id (as the real registry does for an
    // already-registered legacy tool set) surfaces with plugin attribution. This
    // is a core plugin, so its `kanban` id stays bare and collides with the
    // legacy static registration.
    const register = () => {
      throw new Error("Tool set with id 'kanban' has already been registered.");
    };
    await expect(
      loadPlugins({
        pluginNames: ["@platypus/collides"],
        builtinPlugins: {
          "@platypus/collides": () =>
            Promise.resolve({
              plugin: manifest("@platypus/collides", [toolSet("kanban")]),
            }),
        },
        register,
      }),
    ).rejects.toThrow(
      /@platypus\/collides.*"kanban".*already been registered/s,
    );
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
    // Two core plugins keep bare backend ids, so a shared `docker` collides.
    const builtinPlugins = {
      "@a/plugin": () =>
        Promise.resolve({
          plugin: sandboxManifest("@a/plugin", [sandboxBackend("docker")]),
        }),
      "@b/plugin": () =>
        Promise.resolve({
          plugin: sandboxManifest("@b/plugin", [sandboxBackend("docker")]),
        }),
    };

    await expect(
      loadPlugins({
        pluginNames: ["@a/plugin", "@b/plugin"],
        builtinPlugins,
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
    // A core plugin keeps its bare `docker` backend id, colliding with a legacy
    // static registration.
    await expect(
      loadPlugins({
        pluginNames: ["@platypus/collides"],
        builtinPlugins: {
          "@platypus/collides": () =>
            Promise.resolve({
              plugin: sandboxManifest("@platypus/collides", [
                sandboxBackend("docker"),
              ]),
            }),
        },
        register,
        registerSandbox,
      }),
    ).rejects.toThrow(
      /@platypus\/collides.*"docker".*already been registered/s,
    );
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

describe("loadPlugins — third-party namespacing (ADR-0013)", () => {
  it("prefixes third-party tool-set ids with the manifest name; core stays bare", async () => {
    const { register, calls } = makeRegister();
    const builtinPlugins = {
      "@platypus/tools-basic": () =>
        Promise.resolve({
          plugin: manifest("@platypus/tools-basic", [toolSet("time")]),
        }),
    };
    const importPlugin = vi.fn(() =>
      Promise.resolve({ plugin: manifest("example", [toolSet("greeting")]) }),
    );

    const loaded = await loadPlugins({
      pluginNames: ["@platypus/tools-basic", "@example-org/pkg"],
      builtinPlugins,
      importPlugin,
      register,
    });

    // Core keeps its bare id; third-party is `${manifest.name}.${id}`.
    expect(calls.map((c) => c.id)).toEqual(["time", "example.greeting"]);
    expect(loaded[0].toolSetIds).toEqual(["time"]);
    expect(loaded[1].toolSetIds).toEqual(["example.greeting"]);
  });

  it("prefixes third-party sandbox-backend ids too", async () => {
    const { register } = makeRegister();
    const { registerSandbox, calls } = makeSandboxRegister();

    const loaded = await loadPlugins({
      pluginNames: ["@third/infra"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({
          plugin: sandboxManifest("acme", [sandboxBackend("cloud")]),
        }),
      register,
      registerSandbox,
    });

    // The discriminator registered (and stored in `sandbox.backend`) is prefixed.
    expect(calls.map((c) => c.backend)).toEqual(["acme.cloud"]);
    expect(loaded[0].sandboxBackendIds).toEqual(["acme.cloud"]);
  });

  it("treats a package borrowing an @platypus/* name as third-party (prefixed)", async () => {
    const { register, calls } = makeRegister();
    // The static built-in map is the SOLE authority for core. This package is
    // absent from it, so even though its manifest borrows the `@platypus/*`
    // scope it is third-party — prefixed, not smuggled in as core.
    const importPlugin = vi.fn(() =>
      Promise.resolve({
        plugin: manifest("@platypus/impostor", [toolSet("kanban")]),
      }),
    );

    const loaded = await loadPlugins({
      pluginNames: ["@platypus/impostor"],
      builtinPlugins: {},
      importPlugin,
      register,
    });

    expect(importPlugin).toHaveBeenCalledWith("@platypus/impostor");
    // Prefixed — it cannot claim the bare `kanban` core namespace.
    expect(calls.map((c) => c.id)).toEqual(["@platypus/impostor.kanban"]);
    expect(loaded[0].origin).toBe("third-party");
  });
});

describe("loadPlugins — example third-party plugin (end to end)", () => {
  // These exercise the real path: resolve the installed `@platypus-examples/
  // tool-set` package via the loader's default dynamic `import()`, prove its
  // bare `greeting` id namespaces to `example.greeting`, and prove the Chat-turn
  // lookup resolves it under that prefixed id.

  it("loads the installed package via dynamic import and namespaces its id", async () => {
    const { register, calls } = makeRegister();

    const loaded = await loadPlugins({
      pluginNames: ["@platypus-examples/tool-set"],
      builtinPlugins: {},
      register,
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].origin).toBe("third-party");
    expect(loaded[0].name).toBe("example");
    expect(loaded[0].toolSetIds).toEqual(["example.greeting"]);
    expect(calls.map((c) => c.id)).toEqual(["example.greeting"]);
  });

  it("registers into the real registry so a Chat turn resolves it by the prefixed id", async () => {
    await loadPlugins({
      pluginNames: ["@platypus-examples/tool-set"],
      builtinPlugins: {},
      register: registerToolSet,
    });

    // Chat-turn resolution walks the tool-set registry by id (ADR-0013): the
    // example plugin is reachable only under its namespaced id.
    const set = getToolSet("example.greeting");
    expect(set.category).toBe("Examples");
    expect(() => getToolSet("greeting")).toThrow(/has not been registered/);

    if (typeof set.tools === "function") {
      throw new Error("expected a static tool map");
    }
    const result = (await set.tools.greet.execute!(
      { name: "Ada" },
      { toolCallId: "t1", messages: [] },
    )) as string;
    expect(result).toContain("Ada");
  });
});
