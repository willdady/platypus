import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  OLDEST_SUPPORTED_API_VERSION,
  PLUGIN_API_VERSION,
  type PlatypusPlugin,
  type PluginConfigContext,
  type SandboxBackend,
  type SandboxBackendContribution,
  type ToolSetContribution,
} from "@platypuschat/plugin-sdk";
import { loadPlugins, parsePluginConfig, parsePluginList } from "./loader.ts";
import { plugin as examplePlugin } from "./example/index.ts";
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
          plugin: manifest("exactpkg", [toolSet("exact")], PLUGIN_API_VERSION),
        }),
      register,
    });
    // Third-party ids are namespaced by the manifest name (a slug), not the
    // list specifier.
    expect(calls.map((c) => c.id)).toEqual(["exactpkg.exact"]);
    expect(loaded[0].name).toBe("exactpkg");
  });

  it("accepts a plugin on the previous major (N−1)", async () => {
    const { register, calls } = makeRegister();
    const loaded = await loadPlugins({
      pluginNames: ["@nminus1/plugin"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({
          plugin: manifest(
            "nminus1",
            [toolSet("older")],
            OLDEST_SUPPORTED_API_VERSION,
          ),
        }),
      register,
    });
    expect(calls.map((c) => c.id)).toEqual(["nminus1.older"]);
    expect(loaded[0].name).toBe("nminus1");
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
      // At core major 1 the oldest-supported floor is 1, so there is no valid
      // positive-integer major below it — a sub-floor value (0) is rejected by
      // the positive-integer guard. The "below the oldest" branch only becomes
      // reachable once core reaches major ≥ 2.
      /@ancient\/plugin.*apiVersion.*must be a positive integer/s,
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
        plugin: manifest("thirdparty", [toolSet("custom")]),
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
    expect(calls.map((c) => c.id)).toEqual(["thirdparty.custom"]);
    expect(loaded[0].origin).toBe("third-party");
    expect(loaded[0].toolSetIds).toEqual(["thirdparty.custom"]);
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
        plugin: manifest("thirdparty", [toolSet("custom")]),
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
    expect(calls.map((c) => c.id)).toEqual(["time", "thirdparty.custom"]);
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

describe("parsePluginConfig", () => {
  it("returns an empty map for unset or empty input", () => {
    expect(parsePluginConfig(undefined)).toEqual({});
    expect(parsePluginConfig("")).toEqual({});
    expect(parsePluginConfig("   ")).toEqual({});
  });

  it("parses a JSON object keyed by plugin name", () => {
    const raw = JSON.stringify({
      "@acme/daytona": {
        config: { region: "eu" },
        credentials: { apiToken: "secret" },
      },
    });
    expect(parsePluginConfig(raw)).toEqual({
      "@acme/daytona": {
        config: { region: "eu" },
        credentials: { apiToken: "secret" },
      },
    });
  });

  it("tolerates entries that omit config or credentials", () => {
    const raw = JSON.stringify({ "@acme/one": { config: { a: 1 } } });
    expect(parsePluginConfig(raw)).toEqual({
      "@acme/one": { config: { a: 1 }, credentials: undefined },
    });
  });

  it("throws (fail-loud) on malformed JSON", () => {
    expect(() => parsePluginConfig("{not json")).toThrow(
      /PLATYPUS_PLUGIN_CONFIG is not valid JSON/,
    );
  });

  it("throws (fail-loud) when the root is not an object", () => {
    expect(() => parsePluginConfig("[]")).toThrow(
      /must be a JSON object keyed by plugin name/,
    );
    expect(() => parsePluginConfig('"x"')).toThrow(
      /must be a JSON object keyed by plugin name/,
    );
  });

  it("throws (fail-loud) when an entry is not an object", () => {
    expect(() =>
      parsePluginConfig(JSON.stringify({ "@acme/bad": "token" })),
    ).toThrow(/@acme\/bad.*must be an object/s);
  });
});

describe("loadPlugins — deploy-time plugin config injection", () => {
  // A plugin declaring plugin-level schemas plus one factory tool set and one
  // sandbox backend, both of which record the injected PluginConfigContext.
  const configuredManifest = (
    name: string,
    seen: { toolSet?: PluginConfigContext; sandbox?: PluginConfigContext },
  ): PlatypusPlugin => ({
    name,
    version: "0.1.0",
    apiVersion: 1,
    configSchema: z.object({ region: z.string() }),
    credentialsSchema: z.object({ apiToken: z.string() }),
    contributes: {
      toolSets: [
        {
          id: "managed",
          name: "Managed",
          category: "Test",
          tools: (_ctx, plugin) => {
            seen.toolSet = plugin;
            return {};
          },
        },
      ],
      sandboxBackends: [
        {
          backend: "cloud",
          name: "Cloud",
          configSchema: z.object({}),
          credentialsSchema: z.object({}),
          create: (_config, _credentials, plugin) => {
            seen.sandbox = plugin;
            return {} as unknown as SandboxBackend;
          },
        },
      ],
    },
  });

  it("validates and injects resolved config/credentials into every factory", async () => {
    const seen: {
      toolSet?: PluginConfigContext;
      sandbox?: PluginConfigContext;
    } = {};
    const registered: Record<string, Omit<ToolSetContribution, "id">> = {};
    const register = (id: string, def: Omit<ToolSetContribution, "id">) => {
      registered[id] = def;
    };
    const sandboxCalls: SandboxBackendContribution[] = [];
    const registerSandbox = (c: SandboxBackendContribution) => {
      sandboxCalls.push(c);
    };

    await loadPlugins({
      pluginNames: ["acmecloud"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({ plugin: configuredManifest("acmecloud", seen) }),
      register,
      registerSandbox,
      pluginConfig: {
        acmecloud: {
          config: { region: "eu" },
          credentials: { apiToken: "tok_123" },
        },
      },
    });

    // Tool-set factory: invoked as core would at Chat-turn time, with ctx only.
    // Third-party ids are namespaced, so the registry key is prefixed.
    const toolsFactory = registered["acmecloud.managed"].tools;
    expect(typeof toolsFactory).toBe("function");
    await (toolsFactory as (ctx: unknown) => unknown)({
      workspaceId: "w",
      agentId: "a",
      orgId: "o",
      frontendUrl: undefined,
      userId: "u",
    });

    // Sandbox create(): invoked as core would, with the per-Workspace values.
    sandboxCalls[0].create({}, {});

    expect(seen.toolSet).toEqual({
      config: { region: "eu" },
      credentials: { apiToken: "tok_123" },
    });
    expect(seen.sandbox).toEqual({
      config: { region: "eu" },
      credentials: { apiToken: "tok_123" },
    });
  });

  it("shares one credential block across contributions (same object identity)", async () => {
    const seen: {
      toolSet?: PluginConfigContext;
      sandbox?: PluginConfigContext;
    } = {};
    const registered: Record<string, Omit<ToolSetContribution, "id">> = {};
    const register = (id: string, def: Omit<ToolSetContribution, "id">) => {
      registered[id] = def;
    };
    const sandboxCalls: SandboxBackendContribution[] = [];

    await loadPlugins({
      pluginNames: ["acmecloud"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({ plugin: configuredManifest("acmecloud", seen) }),
      register,
      registerSandbox: (c) => sandboxCalls.push(c),
      pluginConfig: {
        acmecloud: {
          config: { region: "eu" },
          credentials: { apiToken: "tok_123" },
        },
      },
    });

    await (registered["acmecloud.managed"].tools as (ctx: unknown) => unknown)({
      workspaceId: "w",
      agentId: "a",
      orgId: "o",
      frontendUrl: undefined,
      userId: "u",
    });
    sandboxCalls[0].create({}, {});

    // The two contributions must be handed the *same* resolved block — one
    // credential block per plugin, shared deployment-wide (ADR-0013).
    expect(seen.toolSet).toBe(seen.sandbox);
  });

  it("aborts (fail-loud) when deploy-time credentials fail validation", async () => {
    await expect(
      loadPlugins({
        pluginNames: ["acmecloud"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({ plugin: configuredManifest("acmecloud", {}) }),
        register: () => {},
        registerSandbox: () => {},
        pluginConfig: {
          acmecloud: {
            config: { region: "eu" },
            // apiToken missing → credentialsSchema rejects.
            credentials: {},
          },
        },
      }),
    ).rejects.toThrow(/acmecloud.*credentials failed validation/s);
  });

  it("aborts (fail-loud) when deploy-time config fails validation", async () => {
    await expect(
      loadPlugins({
        pluginNames: ["acmecloud"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({ plugin: configuredManifest("acmecloud", {}) }),
        register: () => {},
        registerSandbox: () => {},
        pluginConfig: {
          acmecloud: {
            // region missing → configSchema rejects.
            config: {},
            credentials: { apiToken: "tok_123" },
          },
        },
      }),
    ).rejects.toThrow(/acmecloud.*config failed validation/s);
  });

  it("passes undefined config/credentials to plugins declaring no schemas", async () => {
    let seenPlugin: PluginConfigContext | undefined;
    const registered: Record<string, Omit<ToolSetContribution, "id">> = {};

    await loadPlugins({
      pluginNames: ["noschema"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({
          plugin: {
            name: "noschema",
            version: "0.1.0",
            apiVersion: 1,
            contributes: {
              toolSets: [
                {
                  id: "plain",
                  name: "Plain",
                  category: "Test",
                  tools: (_ctx, plugin) => {
                    seenPlugin = plugin;
                    return {};
                  },
                },
              ],
            },
          } satisfies PlatypusPlugin,
        }),
      register: (id, def) => {
        registered[id] = def;
      },
    });

    await (registered["noschema.plain"].tools as (ctx: unknown) => unknown)({
      workspaceId: "w",
      agentId: "a",
      orgId: "o",
      frontendUrl: undefined,
      userId: "u",
    });

    expect(seenPlugin).toEqual({ config: undefined, credentials: undefined });
  });
});

describe("loadPlugins — example third-party plugin", () => {
  // Proves the documented example plugin wires one shared credential block into
  // BOTH its Sandbox backend and its management Tool set (ADR-0013).
  it("shares one credential block across its two contributions", async () => {
    const registered: Record<string, Omit<ToolSetContribution, "id">> = {};
    const sandboxCalls: SandboxBackendContribution[] = [];

    const loaded = await loadPlugins({
      pluginNames: ["example-cloud-sandbox"],
      builtinPlugins: {},
      importPlugin: () => Promise.resolve({ plugin: examplePlugin }),
      register: (id, def) => {
        registered[id] = def;
      },
      registerSandbox: (c) => sandboxCalls.push(c),
      pluginConfig: {
        "example-cloud-sandbox": {
          config: { region: "ap" },
          credentials: { apiToken: "dtn_shared_token" },
        },
      },
    });

    expect(loaded[0]).toMatchObject({
      name: "example-cloud-sandbox",
      origin: "third-party",
      // Third-party contribution ids are namespaced by the manifest name.
      toolSetIds: ["example-cloud-sandbox.management"],
      sandboxBackendIds: ["example-cloud-sandbox.sandbox"],
    });

    // Sandbox backend: create() with per-Workspace values; the adapter reads
    // the deploy-time token/region injected as the third argument.
    const backend = sandboxCalls[0].create({}, {}) as unknown as {
      apiToken: string;
      region: string;
    };
    expect(backend.apiToken).toBe("dtn_shared_token");
    expect(backend.region).toBe("ap");

    // Management tool set: its tool description reflects the SAME token/region.
    const toolsFactory = registered["example-cloud-sandbox.management"]
      .tools as unknown as (
      ctx: unknown,
    ) => Promise<Record<string, { execute: (i: unknown) => Promise<string> }>>;
    const tools = await toolsFactory({
      workspaceId: "w",
      agentId: "a",
      orgId: "o",
      frontendUrl: undefined,
      userId: "u",
    });
    const msg = await tools.listSandboxes.execute({});
    expect(msg).toContain("ap");
    expect(msg).toContain("dtn");
  });

  it("aborts (fail-loud) when the example plugin's token is missing", async () => {
    await expect(
      loadPlugins({
        pluginNames: ["example-cloud-sandbox"],
        builtinPlugins: {},
        importPlugin: () => Promise.resolve({ plugin: examplePlugin }),
        register: () => {},
        registerSandbox: () => {},
        pluginConfig: {
          "example-cloud-sandbox": { config: { region: "ap" } },
        },
      }),
    ).rejects.toThrow(/example-cloud-sandbox.*credentials failed validation/s);
  });
});

describe("loadPlugins — always-on core set (ADR-0013 amendment)", () => {
  it("loads always-on plugins even when the gate-able list is empty", async () => {
    const { register, calls } = makeRegister();
    const builtinPlugins = {
      "@platypus/tools-basic": () =>
        Promise.resolve({
          plugin: manifest("@platypus/tools-basic", [toolSet("time")]),
        }),
      "@platypus/tools-platform": () =>
        Promise.resolve({
          plugin: manifest("@platypus/tools-platform", [toolSet("kanban")]),
        }),
    };

    const loaded = await loadPlugins({
      pluginNames: [],
      alwaysOnPlugins: ["@platypus/tools-basic", "@platypus/tools-platform"],
      builtinPlugins,
      register,
    });

    // Both always-on core plugins load and register their (bare, core) ids,
    // despite an empty gate-able list.
    expect(calls.map((c) => c.id)).toEqual(["time", "kanban"]);
    expect(loaded.map((p) => p.name)).toEqual([
      "@platypus/tools-basic",
      "@platypus/tools-platform",
    ]);
    expect(loaded.every((p) => p.origin === "core")).toBe(true);
  });

  it("loads always-on ahead of the gate-able list", async () => {
    const { register, calls } = makeRegister();
    const builtinPlugins = {
      "@platypus/tools-basic": () =>
        Promise.resolve({
          plugin: manifest("@platypus/tools-basic", [toolSet("time")]),
        }),
      "@platypus/web-fetch": () =>
        Promise.resolve({
          plugin: manifest("@platypus/web-fetch", [toolSet("webFetch")]),
        }),
    };

    await loadPlugins({
      pluginNames: ["@platypus/web-fetch"],
      alwaysOnPlugins: ["@platypus/tools-basic"],
      builtinPlugins,
      register,
    });

    // Always-on first, then the listed gate-able plugin.
    expect(calls.map((c) => c.id)).toEqual(["time", "webFetch"]);
  });

  it("aborts (fail-loud) when an always-on plugin is listed in PLATYPUS_PLUGINS", async () => {
    const { register } = makeRegister();
    const builtinPlugins = {
      "@platypus/tools-basic": () =>
        Promise.resolve({
          plugin: manifest("@platypus/tools-basic", [toolSet("time")]),
        }),
    };

    await expect(
      loadPlugins({
        pluginNames: ["@platypus/tools-basic"],
        alwaysOnPlugins: ["@platypus/tools-basic"],
        builtinPlugins,
        register,
      }),
    ).rejects.toThrow(
      /@platypus\/tools-basic.*always-on.*must not appear in PLATYPUS_PLUGINS/s,
    );
  });
});

describe("loadPlugins — deploy-time config targeting (ADR-0013)", () => {
  it("aborts (fail-loud) when a config entry matches no loaded plugin", async () => {
    await expect(
      loadPlugins({
        pluginNames: ["@third/party"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({ plugin: manifest("acme", [toolSet("custom")]) }),
        register: () => {},
        pluginConfig: {
          // Keyed by a name no loaded plugin carries — a typo or a missing
          // plugin. Silently dropping it would hide a real misconfiguration.
          "acme-typo": { credentials: { apiToken: "x" } },
        },
      }),
    ).rejects.toThrow(/PLATYPUS_PLUGIN_CONFIG.*"acme-typo".*no loaded plugin/s);
  });

  it("accepts a config entry keyed by the manifest name (not the list specifier)", async () => {
    // The list entry is the import specifier; config is keyed by manifest name.
    await expect(
      loadPlugins({
        pluginNames: ["@acme/platypus-widgets"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({
            plugin: {
              name: "widgets",
              version: "0.1.0",
              apiVersion: 1,
              configSchema: z.object({ region: z.string() }),
              contributes: { toolSets: [toolSet("w")] },
            } satisfies PlatypusPlugin,
          }),
        register: () => {},
        pluginConfig: { widgets: { config: { region: "eu" } } },
      }),
    ).resolves.toBeDefined();
  });
});

describe("loadPlugins — apiVersion integer hardening (ADR-0013)", () => {
  it("rejects a non-integer apiVersion", async () => {
    await expect(
      loadPlugins({
        pluginNames: ["@bad/plugin"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({
            plugin: {
              name: "bad",
              version: "0.1.0",
              apiVersion: 1.5,
              contributes: {},
            },
          }),
        register: () => {},
      }),
    ).rejects.toThrow(/@bad\/plugin.*apiVersion.*positive integer/s);
  });

  it("rejects a zero apiVersion (no phantom v0)", async () => {
    await expect(
      loadPlugins({
        pluginNames: ["@bad/plugin"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({
            plugin: {
              name: "bad",
              version: "0.1.0",
              apiVersion: 0,
              contributes: {},
            },
          }),
        register: () => {},
      }),
    ).rejects.toThrow(/@bad\/plugin.*apiVersion.*positive integer/s);
  });
});

describe("loadPlugins — third-party name slug validation (ADR-0013)", () => {
  it("rejects a third-party manifest name that is not a url-safe slug", async () => {
    await expect(
      loadPlugins({
        pluginNames: ["@acme/pkg"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({
            // A scoped, slash-bearing name would produce an ugly, fragile
            // `@acme/thing.custom` contribution id.
            plugin: manifest("@acme/thing", [toolSet("custom")]),
          }),
        register: () => {},
      }),
    ).rejects.toThrow(/@acme\/pkg.*"@acme\/thing".*url-safe slug/s);
  });

  it("accepts a clean slug name and prefixes contribution ids with it", async () => {
    const { register, calls } = makeRegister();
    const loaded = await loadPlugins({
      pluginNames: ["@acme/platypus-widgets"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({ plugin: manifest("widgets", [toolSet("greeting")]) }),
      register,
    });

    expect(calls.map((c) => c.id)).toEqual(["widgets.greeting"]);
    expect(loaded[0].name).toBe("widgets");
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
        plugin: manifest("impostor", [toolSet("kanban")]),
      }),
    );

    const loaded = await loadPlugins({
      pluginNames: ["@platypus/impostor"],
      builtinPlugins: {},
      importPlugin,
      register,
    });

    expect(importPlugin).toHaveBeenCalledWith("@platypus/impostor");
    // Prefixed by the manifest slug — it cannot claim the bare `kanban` core
    // namespace even though its list specifier borrows the `@platypus/*` scope.
    expect(calls.map((c) => c.id)).toEqual(["impostor.kanban"]);
    expect(loaded[0].origin).toBe("third-party");
  });
});

describe("loadPlugins — example third-party npm package (end to end)", () => {
  // These exercise the real path for the installed `@platypus-examples/tool-set`
  // package: resolve it via the loader's default dynamic `import()`, prove its
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
