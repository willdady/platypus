import { afterEach, describe, it, expect, vi } from "vitest";
import pino from "pino";
import { z } from "zod";
import {
  OLDEST_SUPPORTED_API_VERSION,
  PLUGIN_API_VERSION,
  type PlatypusPlugin,
  type PluginConfigContext,
  type SandboxBackend,
  type SandboxBackendContribution,
  type ToolGateContribution,
  type ToolSetContribution,
  type WebBackendContribution,
} from "@platypuschat/plugin-sdk";
import { MAX_PLUGIN_NAME_LENGTH } from "@platypus/schemas";
import {
  MAX_WEB_TIMEOUT_MS,
  type WebBackendRegistration,
} from "../web-backends/index.ts";
import type { SandboxBackendRegistration } from "../sandbox/index.ts";
import {
  DEFAULT_TOOL_GATE_TIMEOUT_MS,
  MAX_TOOL_GATE_TIMEOUT_MS,
  type ToolGateRegistration,
} from "../tool-gates/index.ts";
import {
  loadPlugins,
  parsePluginList,
  type PluginLoggerParent,
} from "./loader.ts";
import { plugin as examplePlugin } from "./example-cloud-sandbox.test-fixtures.ts";
import {
  registerToolSet,
  getToolSet,
  type ToolSetRegistration,
} from "../tools/index.ts";

const makeRegister = () => {
  const calls: Array<{ id: string; registration: ToolSetRegistration }> = [];
  const register = (id: string, registration: ToolSetRegistration) => {
    calls.push({ id, registration });
  };
  return { register, calls };
};

const makeSandboxRegister = () => {
  const calls: SandboxBackendRegistration[] = [];
  const registerSandbox = (registration: SandboxBackendRegistration) => {
    calls.push(registration);
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
  apiVersion: PLUGIN_API_VERSION,
  contributes: { sandboxBackends },
});

const toolSet = (id: string): ToolSetContribution => ({
  id,
  name: id,
  category: "Test",
  description: `${id} tools`,
  tools: {},
});

const A_LOGGER_MATCHER = expect.anything() as unknown;

const captureLogger = (level: string) => {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level },
    {
      write: (chunk: string) =>
        lines.push(JSON.parse(chunk) as Record<string, unknown>),
    },
  );
  return { logger, lines };
};

const makeWebRegister = () => {
  const calls: WebBackendRegistration[] = [];
  const registerWeb = (registration: WebBackendRegistration) => {
    calls.push(registration);
  };
  return { registerWeb, calls };
};

const webManifest = (
  name: string,
  webBackends: WebBackendContribution[],
): PlatypusPlugin => ({
  name,
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  contributes: { webBackends },
});

const webBackend = (backend: string): WebBackendContribution => ({
  backend,
  name: backend,
  createExecutors: () => ({
    web_search: () => ({ query: "", results: [] }),
  }),
});

const sandboxBackend = (backend: string): SandboxBackendContribution => ({
  backend,
  name: backend,
  configSchema: z.object({}),
  credentialsSchema: z.object({}),
  create: () => ({}) as unknown as SandboxBackend,
});

describe("parsePluginList", () => {
  it("splits, trims, and drops blank entries", () => {
    expect(parsePluginList("a, b ,, c")).toEqual(["a", "b", "c"]);
    expect(parsePluginList(",@platypus/docker")).toEqual(["@platypus/docker"]);
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
    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["@exact/plugin"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({
          plugin: manifest("exactpkg", [toolSet("exact")], PLUGIN_API_VERSION),
        }),
      register,
    });
    expect(calls.map((c) => c.id)).toEqual(["exactpkg.exact"]);
    expect(loaded[0].name).toBe("exactpkg");
  });

  it("accepts a plugin on the previous major (N−1)", async () => {
    const { register, calls } = makeRegister();
    const { plugins: loaded } = await loadPlugins({
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
      new RegExp(
        `@ancient/plugin.*targets API v${OLDEST_SUPPORTED_API_VERSION - 1}, below the oldest core supports.*Core supports v${OLDEST_SUPPORTED_API_VERSION}–v${PLUGIN_API_VERSION}`,
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

    const { plugins: loaded } = await loadPlugins({
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
        webBackendIds: [],
        toolGateIds: [],
      },
    ]);
  });

  it("registers nothing for an empty list and does not crash", async () => {
    const { register, calls } = makeRegister();
    const { plugins: loaded, owners } = await loadPlugins({
      pluginNames: [],
      builtinPlugins: {},
      register,
    });
    expect(loaded).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(owners.toolSets.size).toBe(0);
    expect(owners.sandboxBackends.size).toBe(0);
    expect(owners.webBackends.size).toBe(0);
  });

  it("returns the id → plugin owner map it built while registering", async () => {
    const { register } = makeRegister();
    const { registerSandbox } = makeSandboxRegister();
    const { registerWeb } = makeWebRegister();

    const { owners } = await loadPlugins({
      pluginNames: ["@platypus/tools-basic", "@acme/search"],
      builtinPlugins: {
        "@platypus/tools-basic": () =>
          Promise.resolve({
            plugin: {
              ...manifest("@platypus/tools-basic", [toolSet("time")]),
              contributes: {
                toolSets: [toolSet("time")],
                sandboxBackends: [sandboxBackend("docker")],
              },
            },
          }),
      },
      importPlugin: () =>
        Promise.resolve({ plugin: webManifest("acme", [webBackend("searx")]) }),
      register,
      registerSandbox,
      registerWeb,
    });

    expect([...owners.toolSets]).toEqual([["time", "@platypus/tools-basic"]]);
    expect([...owners.sandboxBackends]).toEqual([
      ["docker", "@platypus/tools-basic"],
    ]);
    expect([...owners.webBackends]).toEqual([["acme.searx", "acme"]]);
  });

  it("resolves a third-party plugin via dynamic import", async () => {
    const { register, calls } = makeRegister();
    const importPlugin = vi.fn((_name: string) =>
      Promise.resolve({
        plugin: manifest("thirdparty", [toolSet("custom")]),
      }),
    );

    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["@third/party"],
      builtinPlugins: {},
      importPlugin,
      register,
    });

    expect(importPlugin).toHaveBeenCalledWith("@third/party");
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

    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["@platypus/tools-basic", "@third/party"],
      builtinPlugins,
      importPlugin,
      register,
    });

    expect(importPlugin).toHaveBeenCalledTimes(1);
    expect(importPlugin).toHaveBeenCalledWith("@third/party");
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
            plugin: {
              name: "@bad/plugin",
              version: "0.1.0",
              apiVersion: PLUGIN_API_VERSION,
            },
          }),
        register,
      }),
    ).rejects.toThrow(/@bad\/plugin.*contributes/s);
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

  it.each([
    [
      "a missing category",
      { id: "broken", name: "Broken", description: "Test", tools: {} },
      /@platypus\/bad.*tool set "broken".*non-empty "category"/s,
    ],
    [
      "a whitespace-only category",
      {
        id: "broken",
        name: "Broken",
        category: "   ",
        description: "Test",
        tools: {},
      },
      /@platypus\/bad.*tool set "broken".*non-empty "category"/s,
    ],
    [
      "a missing description",
      { id: "broken", name: "Broken", category: "Test", tools: {} },
      /@platypus\/bad.*tool set "broken".*non-empty "description"/s,
    ],
    [
      "a whitespace-only description",
      {
        id: "broken",
        name: "Broken",
        category: "Test",
        description: "   ",
        tools: {},
      },
      /@platypus\/bad.*tool set "broken".*non-empty "description"/s,
    ],
    [
      "missing tools",
      { id: "broken", name: "Broken", category: "Test", description: "Test" },
      /@platypus\/bad.*tool set "broken".*"tools" object or function/s,
    ],
    [
      "an array tools",
      {
        id: "broken",
        name: "Broken",
        category: "Test",
        description: "Test",
        tools: [],
      },
      /@platypus\/bad.*tool set "broken".*"tools" object or function/s,
    ],
  ])(
    "aborts (fail-loud, plugin-named) on %s",
    async (_label, contribution, expected) => {
      const { register, calls } = makeRegister();
      await expect(
        loadPlugins({
          pluginNames: ["@platypus/bad"],
          builtinPlugins: {
            "@platypus/bad": () =>
              Promise.resolve({
                plugin: {
                  name: "@platypus/bad",
                  version: "0.1.0",
                  apiVersion: PLUGIN_API_VERSION,
                  contributes: {
                    toolSets: [
                      contribution,
                    ] as unknown as ToolSetContribution[],
                  },
                },
              }),
          },
          register,
        }),
      ).rejects.toThrow(expected);
      expect(calls).toHaveLength(0);
    },
  );

  it("aborts (fail-loud) on a duplicate id, naming both owning plugins", async () => {
    const { register } = makeRegister();
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

  it("aborts (fail-loud) when one third-party plugin contributes an id twice", async () => {
    const { register } = makeRegister();
    const importPlugin = vi.fn(() =>
      Promise.resolve({
        plugin: manifest("dup", [toolSet("custom"), toolSet("custom")]),
      }),
    );

    await expect(
      loadPlugins({
        pluginNames: ["@a/pkg"],
        builtinPlugins: {},
        importPlugin,
        register,
      }),
    ).rejects.toThrow(/"dup\.custom".*"dup".*"dup"/s);
  });

  it("re-throws a legacy-registry collision with plugin attribution", async () => {
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
    const { plugins: loaded } = await loadPlugins({
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
        webBackendIds: [],
        toolGateIds: [],
      },
    ]);
  });

  it("calls a class-instance backend's create on the backend itself", async () => {
    const created = {} as SandboxBackend;
    class OwnStateBackend {
      backend = "own";
      name = "Own";
      configSchema = z.object({});
      credentialsSchema = z.object({});
      instance = created;
      create() {
        return this.instance;
      }
    }
    const { registerSandbox, calls } = makeSandboxRegister();
    await loadPlugins({
      pluginNames: ["@platypus/own"],
      builtinPlugins: {
        "@platypus/own": () =>
          Promise.resolve({
            plugin: sandboxManifest("@platypus/own", [new OwnStateBackend()]),
          }),
      },
      register: () => {},
      registerSandbox,
    });

    expect(calls[0].create({}, {})).toBe(created);
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
              apiVersion: PLUGIN_API_VERSION,
              contributes: { sandboxBackends: {} },
            },
          }),
        register,
        registerSandbox: () => {},
      }),
    ).rejects.toThrow(/@bad\/plugin.*sandboxBackends.*array/s);
  });

  it.each([
    [
      "a missing create",
      {
        backend: "b",
        name: "x",
        configSchema: z.object({}),
        credentialsSchema: z.object({}),
      },
      /@platypus\/bad.*must provide a "create" function/s,
    ],
    [
      "a missing configSchema",
      {
        backend: "b",
        name: "x",
        credentialsSchema: z.object({}),
        create: () => ({}),
      },
      /@platypus\/bad.*must provide a Zod "configSchema"/s,
    ],
    [
      "a missing credentialsSchema",
      {
        backend: "b",
        name: "x",
        configSchema: z.object({}),
        create: () => ({}),
      },
      /@platypus\/bad.*must provide a Zod "credentialsSchema"/s,
    ],
    [
      "a throwing configSchema factory",
      {
        backend: "b",
        name: "x",
        configSchema: () => {
          throw new Error("region is required");
        },
        credentialsSchema: z.object({}),
        create: () => ({}),
      },
      /@platypus\/bad.*configSchema factory threw.*region is required/s,
    ],
  ])(
    "aborts (fail-loud, plugin-named) on %s",
    async (_label, contribution, expected) => {
      const { register } = makeRegister();
      await expect(
        loadPlugins({
          pluginNames: ["@platypus/bad"],
          builtinPlugins: {
            "@platypus/bad": () =>
              Promise.resolve({
                plugin: {
                  name: "@platypus/bad",
                  version: "0.1.0",
                  apiVersion: PLUGIN_API_VERSION,
                  contributes: {
                    sandboxBackends: [
                      contribution,
                    ] as unknown as SandboxBackendContribution[],
                  },
                },
              }),
          },
          register,
          registerSandbox: () => {},
        }),
      ).rejects.toThrow(expected);
    },
  );

  it("resolves a factory-form configSchema against the plugin context at load (v2)", async () => {
    const { register } = makeRegister();
    const { registerSandbox, calls } = makeSandboxRegister();

    const factoryBackend: SandboxBackendContribution = {
      backend: "fenced",
      name: "Fenced",
      configSchema: (plugin) => {
        const { allowed } = plugin.config as { allowed: string[] };
        return z
          .object({ net: z.string() })
          .refine((c) => allowed.includes(c.net), { message: "not allowed" });
      },
      credentialsSchema: z.object({}),
      create: () => ({}) as unknown as SandboxBackend,
    };

    await loadPlugins({
      pluginNames: ["fencedpkg"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({
          plugin: {
            name: "fenced",
            version: "0.1.0",
            apiVersion: PLUGIN_API_VERSION,
            configSchema: z.object({
              allowed: z.array(z.string()).default([]),
            }),
            contributes: { sandboxBackends: [factoryBackend] },
          } satisfies PlatypusPlugin,
        }),
      register,
      registerSandbox,
      env: {
        PLATYPUS_PLUGIN_CONFIG_FENCED: '{"config":{"allowed":["ok"]}}',
      },
    });

    const [registered] = calls;
    expect(typeof registered.configSchema).not.toBe("function");
    const schema = registered.configSchema;
    expect(schema.safeParse({ net: "ok" }).success).toBe(true);
    expect(schema.safeParse({ net: "blocked" }).success).toBe(false);
  });

  it("registers a plain (non-factory) configSchema unchanged", async () => {
    const { register } = makeRegister();
    const { registerSandbox, calls } = makeSandboxRegister();
    const plain = z.object({ a: z.string() });
    const backend: SandboxBackendContribution = {
      backend: "plain",
      name: "Plain",
      configSchema: plain,
      credentialsSchema: z.object({}),
      create: () => ({}) as unknown as SandboxBackend,
    };

    await loadPlugins({
      pluginNames: ["plainpkg"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({
          plugin: sandboxManifest("plainpkg", [backend]),
        }),
      register,
      registerSandbox,
    });

    expect(calls[0].configSchema).toBe(plain);
  });
});

describe("loadPlugins — web-search backends", () => {
  it("registers a web-backend contribution and reports its id", async () => {
    const { register } = makeRegister();
    const { registerWeb, calls } = makeWebRegister();
    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["@platypus/searx"],
      builtinPlugins: {
        "@platypus/searx": () =>
          Promise.resolve({
            plugin: webManifest("@platypus/searx", [webBackend("searx")]),
          }),
      },
      register,
      registerWeb,
    });

    expect(calls.map((c) => c.backend)).toEqual(["searx"]);
    expect(typeof calls[0].buildTurnTools).toBe("function");
    expect(loaded[0]).toMatchObject({
      name: "@platypus/searx",
      origin: "core",
      webBackendIds: ["searx"],
    });
  });

  it("prefixes a third-party web-backend id with the manifest name", async () => {
    const { register } = makeRegister();
    const { registerWeb, calls } = makeWebRegister();
    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["@acme/platypus-search"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({
          plugin: webManifest("acme", [webBackend("web")]),
        }),
      register,
      registerWeb,
    });

    expect(calls.map((c) => c.backend)).toEqual(["acme.web"]);
    expect(loaded[0].webBackendIds).toEqual(["acme.web"]);
  });

  it("aborts (fail-loud) when webBackends is not an array", async () => {
    const { register } = makeRegister();
    await expect(
      loadPlugins({
        pluginNames: ["@bad/plugin"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({
            plugin: {
              name: "bad",
              version: "0.1.0",
              apiVersion: PLUGIN_API_VERSION,
              contributes: { webBackends: {} },
            },
          }),
        register,
        registerWeb: () => {},
      }),
    ).rejects.toThrow(/@bad\/plugin.*webBackends.*array/s);
  });

  it("aborts (fail-loud) when a contribution has no createExecutors function", async () => {
    const { register } = makeRegister();
    const broken = {
      backend: "searx",
      name: "SearXNG",
    } as unknown as ReturnType<typeof webBackend>;

    await expect(
      loadPlugins({
        pluginNames: ["@platypus/searx"],
        builtinPlugins: {
          "@platypus/searx": () =>
            Promise.resolve({
              plugin: webManifest("@platypus/searx", [broken]),
            }),
        },
        register,
        registerWeb: () => {},
      }),
    ).rejects.toThrow(/@platypus\/searx.*"searx".*createExecutors/s);
  });

  it("refuses an over-ceiling timeoutMs at boot rather than clamping it", async () => {
    const { register } = makeRegister();
    await expect(
      loadPlugins({
        pluginNames: ["@platypus/searx"],
        builtinPlugins: {
          "@platypus/searx": () =>
            Promise.resolve({
              plugin: webManifest("@platypus/searx", [
                { ...webBackend("searx"), timeoutMs: MAX_WEB_TIMEOUT_MS + 1 },
              ]),
            }),
        },
        register,
        registerWeb: () => {},
      }),
    ).rejects.toThrow(
      new RegExp(
        `@platypus/searx.*"searx".*timeoutMs.*${MAX_WEB_TIMEOUT_MS}`,
        "s",
      ),
    );
  });

  it("accepts a timeoutMs at the ceiling", async () => {
    const { register } = makeRegister();
    const { registerWeb, calls } = makeWebRegister();
    await loadPlugins({
      pluginNames: ["@platypus/searx"],
      builtinPlugins: {
        "@platypus/searx": () =>
          Promise.resolve({
            plugin: webManifest("@platypus/searx", [
              { ...webBackend("searx"), timeoutMs: MAX_WEB_TIMEOUT_MS },
            ]),
          }),
      },
      register,
      registerWeb,
    });

    expect(calls).toHaveLength(1);
  });

  it('aborts (fail-loud) when a core web backend claims the reserved id "none"', async () => {
    const { register } = makeRegister();
    await expect(
      loadPlugins({
        pluginNames: ["@platypus/searx"],
        builtinPlugins: {
          "@platypus/searx": () =>
            Promise.resolve({
              plugin: webManifest("@platypus/searx", [webBackend("none")]),
            }),
        },
        register,
        registerWeb: () => {},
      }),
    ).rejects.toThrow(/@platypus\/searx.*"none".*reserved/s);
  });

  it('aborts (fail-loud) when a core web backend claims the reserved id "native"', async () => {
    const { register } = makeRegister();
    await expect(
      loadPlugins({
        pluginNames: ["@platypus/searx"],
        builtinPlugins: {
          "@platypus/searx": () =>
            Promise.resolve({
              plugin: webManifest("@platypus/searx", [webBackend("native")]),
            }),
        },
        register,
        registerWeb: () => {},
      }),
    ).rejects.toThrow(/@platypus\/searx.*"native".*reserved/s);
  });

  it('still loads a third-party plugin\'s bare "none" id, namespaced and unaffected', async () => {
    const { register } = makeRegister();
    const { registerWeb, calls } = makeWebRegister();
    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["@acme/platypus-search"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({
          plugin: webManifest("acme", [webBackend("none")]),
        }),
      register,
      registerWeb,
    });

    expect(calls.map((c) => c.backend)).toEqual(["acme.none"]);
    expect(loaded[0].webBackendIds).toEqual(["acme.none"]);
  });

  it("injects the shared plugin config block into createExecutors", async () => {
    const { register } = makeRegister();
    const { registerWeb, calls } = makeWebRegister();
    const createExecutors = vi.fn(() => ({
      web_search: () => ({ query: "q", results: [] }),
    }));

    await loadPlugins({
      pluginNames: ["acme"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({
          plugin: {
            name: "acme",
            version: "0.1.0",
            apiVersion: PLUGIN_API_VERSION,
            configSchema: z.object({ endpoint: z.string() }),
            credentialsSchema: z.object({ apiKey: z.string() }),
            contributes: {
              webBackends: [
                { backend: "web", name: "Acme Search", createExecutors },
              ],
            },
          } satisfies PlatypusPlugin,
        }),
      register,
      registerWeb,
      env: {
        PLATYPUS_PLUGIN_CONFIG_ACME: JSON.stringify({
          config: { endpoint: "https://searx.internal" },
          credentials: { apiKey: "sk-test" },
        }),
      },
    });

    const pluginCtx = { orgId: "org-1", workspaceId: "ws-1", userId: "user-1" };
    await calls[0].buildTurnTools({
      ...pluginCtx,
      providerId: "provider-1",
      registerCloser: () => {},
    });

    expect(createExecutors).toHaveBeenCalledWith(
      { ...pluginCtx, registerCloser: expect.any(Function) as unknown },
      {
        config: { endpoint: "https://searx.internal" },
        credentials: { apiKey: "sk-test" },
        logger: A_LOGGER_MATCHER,
      },
    );
  });
});

const gateManifest = (
  name: string,
  toolGates: ToolGateContribution[],
): PlatypusPlugin => ({
  name,
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  contributes: { toolGates },
});

const toolGate = (id: string): ToolGateContribution => ({
  id,
  name: id,
  evaluate: () => ({ verdict: "allow" }),
});

const loadGates = (
  plugins: Record<string, PlatypusPlugin>,
  env?: Record<string, string>,
) => {
  const calls: ToolGateRegistration[] = [];
  const result = loadPlugins({
    pluginNames: Object.keys(plugins),
    builtinPlugins: {},
    importPlugin: (name) => Promise.resolve({ plugin: plugins[name] }),
    register: () => {},
    registerGate: (registration) => calls.push(registration),
    env,
  });
  return { result, calls };
};

describe("loadPlugins — tool gates", () => {
  it("registers a tool-gate contribution under its namespaced id and reports it", async () => {
    const { result, calls } = loadGates({
      acme: gateManifest("acme", [toolGate("no-drop")]),
    });
    const { plugins: loaded } = await result;

    expect(calls.map((c) => c.id)).toEqual(["acme.no-drop"]);
    expect(calls[0].timeoutMs).toBe(DEFAULT_TOOL_GATE_TIMEOUT_MS);
    expect(loaded[0].toolGateIds).toEqual(["acme.no-drop"]);
  });

  it("aborts (fail-loud) when two plugins' gates collide", async () => {
    const { result } = loadGates({
      "@acme/one": gateManifest("acme", [toolGate("g")]),
      "@acme/two": gateManifest("acme", [toolGate("g")]),
    });
    await expect(result).rejects.toThrow(/acme/);
  });

  it("aborts (fail-loud) when toolGates is not an array", async () => {
    const { result } = loadGates({
      bad: {
        ...gateManifest("bad", []),
        contributes: { toolGates: {} },
      } as unknown as PlatypusPlugin,
    });
    await expect(result).rejects.toThrow(/bad.*toolGates.*array/s);
  });

  it("aborts (fail-loud) when a contribution has no evaluate function", async () => {
    const { result } = loadGates({
      acme: gateManifest("acme", [
        { id: "g", name: "G" } as unknown as ToolGateContribution,
      ]),
    });
    await expect(result).rejects.toThrow(/acme.*"g".*evaluate/s);
  });

  it("refuses an over-ceiling timeoutMs at boot rather than clamping it", async () => {
    const { result } = loadGates({
      acme: gateManifest("acme", [
        { ...toolGate("g"), timeoutMs: MAX_TOOL_GATE_TIMEOUT_MS + 1 },
      ]),
    });
    await expect(result).rejects.toThrow(
      new RegExp(`acme.*"g".*timeoutMs.*${MAX_TOOL_GATE_TIMEOUT_MS}`, "s"),
    );
  });

  it("accepts a timeoutMs at the ceiling", async () => {
    const { result, calls } = loadGates({
      acme: gateManifest("acme", [
        { ...toolGate("g"), timeoutMs: MAX_TOOL_GATE_TIMEOUT_MS },
      ]),
    });
    await result;
    expect(calls[0].timeoutMs).toBe(MAX_TOOL_GATE_TIMEOUT_MS);
  });

  it("injects the shared plugin config block into evaluate", async () => {
    const evaluate = vi.fn(() => ({ verdict: "allow" as const }));
    const { result, calls } = loadGates(
      {
        acme: {
          ...gateManifest("acme", [{ id: "g", name: "G", evaluate }]),
          credentialsSchema: z.object({ apiKey: z.string() }),
        },
      },
      { PLATYPUS_PLUGIN_CONFIG_ACME: '{"credentials":{"apiKey":"sk-test"}}' },
    );
    await result;
    const call = {
      toolName: "t",
      args: {},
      orgId: "o",
      workspaceId: "w",
      attended: false,
      readOnlyHint: "undeclared" as const,
    };
    const options = { signal: new AbortController().signal };
    await calls[0].evaluate(call, options);

    expect(evaluate).toHaveBeenCalledWith(
      call,
      {
        config: undefined,
        credentials: { apiKey: "sk-test" },
        logger: A_LOGGER_MATCHER,
      },
      options,
    );
  });

  it("carries a result stage through and binds the same config block to it", async () => {
    const evaluateResult = vi.fn(() => ({
      verdict: "deny" as const,
      reason: "Screened.",
    }));
    const { result, calls } = loadGates(
      {
        acme: {
          ...gateManifest("acme", [{ ...toolGate("g"), evaluateResult }]),
          credentialsSchema: z.object({ apiKey: z.string() }),
        },
      },
      { PLATYPUS_PLUGIN_CONFIG_ACME: '{"credentials":{"apiKey":"sk-test"}}' },
    );
    await result;
    const call = {
      toolName: "t",
      args: {},
      orgId: "o",
      workspaceId: "w",
      attended: false,
      readOnlyHint: "undeclared" as const,
    };
    const options = { signal: new AbortController().signal };
    await calls[0].evaluateResult?.(call, "the result", options);

    expect(evaluateResult).toHaveBeenCalledWith(
      call,
      "the result",
      {
        config: undefined,
        credentials: { apiKey: "sk-test" },
        logger: A_LOGGER_MATCHER,
      },
      options,
    );
  });

  it("calls a class-instance gate's methods on the gate itself", async () => {
    class OwnVerdictGate implements ToolGateContribution {
      id = "g";
      name = "G";
      verdict = { verdict: "deny" as const, reason: "Own state." };
      evaluate() {
        return this.verdict;
      }
      evaluateResult() {
        return this.verdict;
      }
    }
    const { result, calls } = loadGates({
      acme: gateManifest("acme", [new OwnVerdictGate()]),
    });
    await result;
    const call = {
      toolName: "t",
      args: {},
      orgId: "o",
      workspaceId: "w",
      attended: false,
      readOnlyHint: "undeclared" as const,
    };
    const options = { signal: new AbortController().signal };

    expect(await calls[0].evaluate(call, options)).toEqual({
      verdict: "deny",
      reason: "Own state.",
    });
    expect(await calls[0].evaluateResult?.(call, "r", options)).toEqual({
      verdict: "deny",
      reason: "Own state.",
    });
  });

  it("aborts (fail-loud) when evaluateResult is declared but is not a function", async () => {
    const { result } = loadGates({
      acme: gateManifest("acme", [
        {
          ...toolGate("g"),
          evaluateResult: "nope",
        } as unknown as ToolGateContribution,
      ]),
    });
    await expect(result).rejects.toThrow(/acme.*"g".*evaluateResult/s);
  });
});

describe("loadPlugins — deploy-time plugin config injection", () => {
  const configuredManifest = (
    name: string,
    seen: { toolSet?: PluginConfigContext; sandbox?: PluginConfigContext },
  ): PlatypusPlugin => ({
    name,
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    configSchema: z.object({ region: z.string() }),
    credentialsSchema: z.object({ apiToken: z.string() }),
    contributes: {
      toolSets: [
        {
          id: "managed",
          name: "Managed",
          category: "Test",
          description: "Managed tools",
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
    const registered: Record<string, ToolSetRegistration> = {};
    const register = (id: string, registration: ToolSetRegistration) => {
      registered[id] = registration;
    };
    const sandboxCalls: SandboxBackendRegistration[] = [];
    const registerSandbox = (c: SandboxBackendRegistration) => {
      sandboxCalls.push(c);
    };

    await loadPlugins({
      pluginNames: ["acmecloud"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({ plugin: configuredManifest("acmecloud", seen) }),
      register,
      registerSandbox,
      env: {
        PLATYPUS_PLUGIN_CONFIG_ACMECLOUD: JSON.stringify({
          config: { region: "eu" },
          credentials: { apiToken: "tok_123" },
        }),
      },
    });

    await registered["acmecloud.managed"].buildTurnTools(
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

    sandboxCalls[0].create({}, {});

    expect(seen.toolSet).toEqual({
      config: { region: "eu" },
      credentials: { apiToken: "tok_123" },
      logger: A_LOGGER_MATCHER,
    });
    expect(seen.sandbox).toEqual({
      config: { region: "eu" },
      credentials: { apiToken: "tok_123" },
      logger: A_LOGGER_MATCHER,
    });
  });

  it("shares one credential block across contributions (same object identity)", async () => {
    const seen: {
      toolSet?: PluginConfigContext;
      sandbox?: PluginConfigContext;
    } = {};
    const registered: Record<string, ToolSetRegistration> = {};
    const register = (id: string, registration: ToolSetRegistration) => {
      registered[id] = registration;
    };
    const sandboxCalls: SandboxBackendRegistration[] = [];

    await loadPlugins({
      pluginNames: ["acmecloud"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({ plugin: configuredManifest("acmecloud", seen) }),
      register,
      registerSandbox: (c) => sandboxCalls.push(c),
      env: {
        PLATYPUS_PLUGIN_CONFIG_ACMECLOUD: JSON.stringify({
          config: { region: "eu" },
          credentials: { apiToken: "tok_123" },
        }),
      },
    });

    await registered["acmecloud.managed"].buildTurnTools(
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
    sandboxCalls[0].create({}, {});

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
        env: {
          PLATYPUS_PLUGIN_CONFIG_ACMECLOUD: JSON.stringify({
            config: { region: "eu" },
            credentials: {},
          }),
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
        env: {
          PLATYPUS_PLUGIN_CONFIG_ACMECLOUD: JSON.stringify({
            config: {},
            credentials: { apiToken: "tok_123" },
          }),
        },
      }),
    ).rejects.toThrow(/acmecloud.*config failed validation/s);
  });

  it("passes undefined config/credentials to plugins declaring no schemas", async () => {
    let seenPlugin: PluginConfigContext | undefined;
    const registered: Record<string, ToolSetRegistration> = {};

    await loadPlugins({
      pluginNames: ["noschema"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({
          plugin: {
            name: "noschema",
            version: "0.1.0",
            apiVersion: PLUGIN_API_VERSION,
            contributes: {
              toolSets: [
                {
                  id: "plain",
                  name: "Plain",
                  category: "Test",
                  description: "Plain tools",
                  tools: (_ctx, plugin) => {
                    seenPlugin = plugin;
                    return {};
                  },
                },
              ],
            },
          } satisfies PlatypusPlugin,
        }),
      register: (id, registration) => {
        registered[id] = registration;
      },
    });

    await registered["noschema.plain"].buildTurnTools(
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

    expect(seenPlugin).toEqual({
      config: undefined,
      credentials: undefined,
      logger: A_LOGGER_MATCHER,
    });
  });
});

describe("loadPlugins — plugin logger injection", () => {
  const loggingManifest = (
    name: string,
    seen: Record<string, PluginConfigContext | undefined>,
  ): PlatypusPlugin => ({
    name,
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    contributes: {
      toolSets: [
        {
          id: "tools",
          name: "Tools",
          category: "Test",
          description: "Logging tools",
          tools: (_ctx, plugin) => {
            seen.toolSet = plugin;
            plugin.logger.info({ point: "toolSet" }, "resolving tools");
            return {};
          },
        },
      ],
      sandboxBackends: [
        {
          backend: "sandbox",
          name: "Sandbox",
          configSchema: z.object({}),
          credentialsSchema: z.object({}),
          create: (_config, _credentials, plugin) => {
            seen.sandbox = plugin;
            plugin.logger.info({ point: "sandbox" }, "creating adapter");
            return {} as unknown as SandboxBackend;
          },
        },
      ],
      webBackends: [
        {
          backend: "web",
          name: "Web",
          createExecutors: (_ctx, plugin) => {
            seen.web = plugin;
            plugin.logger.info({ point: "web" }, "building executors");
            return { web_search: () => ({ query: "q", results: [] }) };
          },
        },
      ],
    },
  });

  const invokeAllFactories = async (opts: {
    pluginName: string;
    baseLogger: PluginLoggerParent;
    seen: Record<string, PluginConfigContext | undefined>;
  }) => {
    const registered: Record<string, ToolSetRegistration> = {};
    const sandboxCalls: SandboxBackendRegistration[] = [];
    const { registerWeb, calls: webCalls } = makeWebRegister();

    await loadPlugins({
      pluginNames: [opts.pluginName],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({
          plugin: loggingManifest(opts.pluginName, opts.seen),
        }),
      register: (id, registration) => {
        registered[id] = registration;
      },
      registerSandbox: (c) => sandboxCalls.push(c),
      registerWeb,
      baseLogger: opts.baseLogger,
    });

    await registered[`${opts.pluginName}.tools`].buildTurnTools(
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
    sandboxCalls[0].create({}, {});
    await webCalls[0].buildTurnTools({
      orgId: "o",
      workspaceId: "w",
      userId: "u",
      providerId: "p",
      registerCloser: () => {},
    });
  };

  it("reaches all three Extension points as one logger bound to the manifest name", async () => {
    const { logger, lines } = captureLogger("info");
    const seen: Record<string, PluginConfigContext | undefined> = {};

    await invokeAllFactories({
      pluginName: "acme",
      baseLogger: logger,
      seen,
    });

    expect(seen.toolSet?.logger).toBeDefined();
    expect(seen.sandbox?.logger).toBe(seen.toolSet?.logger);
    expect(seen.web?.logger).toBe(seen.toolSet?.logger);

    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.point)).toEqual(["toolSet", "sandbox", "web"]);
    for (const line of lines) {
      expect(line.plugin).toBe("acme");
      expect(line.msg).toEqual(expect.any(String));
    }
  });

  it("suppresses a plugin line the Operator's LOG_LEVEL excludes", async () => {
    const { logger, lines } = captureLogger("warn");

    await invokeAllFactories({
      pluginName: "acme",
      baseLogger: logger,
      seen: {},
    });

    expect(lines).toEqual([]);
  });

  it("binds each plugin to its own name", async () => {
    const { logger, lines } = captureLogger("info");

    await invokeAllFactories({
      pluginName: "acme",
      baseLogger: logger,
      seen: {},
    });
    await invokeAllFactories({
      pluginName: "widgets",
      baseLogger: logger,
      seen: {},
    });

    expect([...new Set(lines.map((l) => l.plugin))]).toEqual([
      "acme",
      "widgets",
    ]);
  });
});

describe("loadPlugins — example third-party plugin", () => {
  it("shares one credential block across its two contributions", async () => {
    const registered: Record<string, ToolSetRegistration> = {};
    const sandboxCalls: SandboxBackendRegistration[] = [];

    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["example-cloud-sandbox"],
      builtinPlugins: {},
      importPlugin: () => Promise.resolve({ plugin: examplePlugin }),
      register: (id, registration) => {
        registered[id] = registration;
      },
      registerSandbox: (c) => sandboxCalls.push(c),
      env: {
        PLATYPUS_PLUGIN_CONFIG_EXAMPLE_CLOUD_SANDBOX: JSON.stringify({
          config: { region: "ap" },
          credentials: { apiToken: "dtn_shared_token" },
        }),
      },
    });

    expect(loaded[0]).toMatchObject({
      name: "example-cloud-sandbox",
      origin: "third-party",
      toolSetIds: ["example-cloud-sandbox.management"],
      sandboxBackendIds: ["example-cloud-sandbox.sandbox"],
    });

    const backend = sandboxCalls[0].create({}, {}) as unknown as {
      apiToken: string;
      region: string;
    };
    expect(backend.apiToken).toBe("dtn_shared_token");
    expect(backend.region).toBe("ap");

    const tools = (await registered[
      "example-cloud-sandbox.management"
    ].buildTurnTools(
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
    )) as unknown as Record<
      string,
      { execute: (i: unknown) => Promise<string> }
    >;
    const msg = await tools["example-cloud-sandbox__listSandboxes"].execute({});
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
        env: {
          PLATYPUS_PLUGIN_CONFIG_EXAMPLE_CLOUD_SANDBOX:
            '{"config":{"region":"ap"}}',
        },
      }),
    ).rejects.toThrow(/example-cloud-sandbox.*credentials failed validation/s);
  });
});

describe("loadPlugins — the strings your-first-plugin.mdx tells a reader to look for", () => {
  it("resolves @platypus-examples/tool-set and registers example.greeting", async () => {
    const { register, calls } = makeRegister();

    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["@platypus-examples/tool-set"],
      builtinPlugins: {},
      register,
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("example");
    expect(loaded[0].version).toBe("0.1.0");
    expect(loaded[0].origin).toBe("third-party");
    expect(loaded[0].toolSetIds).toEqual(["example.greeting"]);

    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("example.greeting");
    expect(calls[0].registration.name).toBe("Greeting");
    expect(calls[0].registration.category).toBe("Examples");
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

    const { plugins: loaded } = await loadPlugins({
      pluginNames: [],
      alwaysOnPlugins: ["@platypus/tools-basic", "@platypus/tools-platform"],
      builtinPlugins,
      register,
    });

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
  it("accepts a config entry keyed by the manifest name (not the list specifier)", async () => {
    await expect(
      loadPlugins({
        pluginNames: ["@acme/platypus-widgets"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({
            plugin: {
              name: "widgets",
              version: "0.1.0",
              apiVersion: PLUGIN_API_VERSION,
              configSchema: z.object({ region: z.string() }),
              contributes: { toolSets: [toolSet("w")] },
            } satisfies PlatypusPlugin<{ region: string }>,
          }),
        register: () => {},
        env: { PLATYPUS_PLUGIN_CONFIG_WIDGETS: '{"config":{"region":"eu"}}' },
      }),
    ).resolves.toBeDefined();
  });
});

describe("loadPlugins — per-plugin config vars (PLATYPUS_PLUGIN_CONFIG_<NAME>)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const cloudSandbox = {
    ...examplePlugin,
    name: "cloud-sandbox",
  };

  const loadCloudSandbox = () => {
    const sandboxCalls: SandboxBackendRegistration[] = [];
    const result = loadPlugins({
      pluginNames: ["@acme/cloud-sandbox"],
      builtinPlugins: {},
      importPlugin: () => Promise.resolve({ plugin: cloudSandbox }),
      register: () => {},
      registerSandbox: (c) => sandboxCalls.push(c),
    });
    return { result, sandboxCalls };
  };

  it("configures a plugin through its own var, keyed by the uppercased slug", async () => {
    vi.stubEnv(
      "PLATYPUS_PLUGIN_CONFIG_CLOUD_SANDBOX",
      '{"credentials":{"apiToken":"x"}}',
    );
    const { result, sandboxCalls } = loadCloudSandbox();
    await result;

    const backend = sandboxCalls[0].create({}, {}) as unknown as {
      apiToken: string;
      region: string;
    };
    expect(backend.apiToken).toBe("x");
    expect(backend.region).toBe("us");
  });

  it("enforces the plugin's schemas", async () => {
    vi.stubEnv("PLATYPUS_PLUGIN_CONFIG_CLOUD_SANDBOX", '{"credentials":{}}');
    await expect(loadCloudSandbox().result).rejects.toThrow(
      /cloud-sandbox.*credentials failed validation/s,
    );
  });

  it("aborts (fail-loud) when a var matches no loaded plugin", async () => {
    vi.stubEnv(
      "PLATYPUS_PLUGIN_CONFIG_CLOUD_SANDBOXX",
      '{"credentials":{"apiToken":"x"}}',
    );
    vi.stubEnv(
      "PLATYPUS_PLUGIN_CONFIG_CLOUD_SANDBOX",
      '{"credentials":{"apiToken":"x"}}',
    );
    await expect(loadCloudSandbox().result).rejects.toThrow(
      /PLATYPUS_PLUGIN_CONFIG_CLOUD_SANDBOXX.*no loaded plugin/s,
    );
  });

  it("aborts (fail-loud) on a value that is not valid JSON", async () => {
    vi.stubEnv("PLATYPUS_PLUGIN_CONFIG_CLOUD_SANDBOX", "{not json");
    await expect(loadCloudSandbox().result).rejects.toThrow(
      /PLATYPUS_PLUGIN_CONFIG_CLOUD_SANDBOX is not valid JSON/,
    );
  });

  it("aborts (fail-loud) on a value that is not an object", async () => {
    vi.stubEnv("PLATYPUS_PLUGIN_CONFIG_CLOUD_SANDBOX", '["x"]');
    await expect(loadCloudSandbox().result).rejects.toThrow(
      /PLATYPUS_PLUGIN_CONFIG_CLOUD_SANDBOX must be a JSON object/,
    );
  });

  it("aborts (fail-loud) when two loaded plugins map to the same var", async () => {
    await expect(
      loadPlugins({
        pluginNames: ["@platypus/widgets", "@acme/widgets"],
        builtinPlugins: {
          "@platypus/widgets": () =>
            Promise.resolve({
              plugin: manifest("@platypus/widgets", [toolSet("a")]),
            }),
        },
        importPlugin: () =>
          Promise.resolve({ plugin: manifest("widgets", [toolSet("b")]) }),
        register: () => {},
        env: {},
      }),
    ).rejects.toThrow(
      /"@platypus\/widgets".*"widgets".*PLATYPUS_PLUGIN_CONFIG_WIDGETS/s,
    );
  });

  it("aborts (fail-loud) while the removed combined PLATYPUS_PLUGIN_CONFIG is set", async () => {
    vi.stubEnv(
      "PLATYPUS_PLUGIN_CONFIG",
      '{"cloud-sandbox":{"credentials":{"apiToken":"x"}}}',
    );
    vi.stubEnv(
      "PLATYPUS_PLUGIN_CONFIG_CLOUD_SANDBOX",
      '{"credentials":{"apiToken":"x"}}',
    );
    await expect(loadCloudSandbox().result).rejects.toThrow(
      /PLATYPUS_PLUGIN_CONFIG is no longer supported.*PLATYPUS_PLUGIN_CONFIG_<NAME>/s,
    );
  });

  it("treats an empty combined var as unset", async () => {
    vi.stubEnv("PLATYPUS_PLUGIN_CONFIG", "");
    vi.stubEnv(
      "PLATYPUS_PLUGIN_CONFIG_CLOUD_SANDBOX",
      '{"credentials":{"apiToken":"x"}}',
    );
    await expect(loadCloudSandbox().result).resolves.toBeDefined();
  });
});

describe("loadPlugins — apiVersion integer hardening (ADR-0013)", () => {
  it.each([
    ["a non-numeric", "1"],
    ["a non-integer", 1.5],
    ["a zero (no phantom v0)", 0],
  ])("rejects %s apiVersion", async (_label, apiVersion) => {
    await expect(
      loadPlugins({
        pluginNames: ["@bad/plugin"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({
            plugin: {
              name: "bad",
              version: "0.1.0",
              apiVersion,
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
            plugin: manifest("@acme/thing", [toolSet("custom")]),
          }),
        register: () => {},
      }),
    ).rejects.toThrow(/@acme\/pkg.*"@acme\/thing".*url-safe slug/s);
  });

  it("rejects a third-party manifest name over the cap, naming the field, the cap and the length", async () => {
    const tooLong = "a".repeat(MAX_PLUGIN_NAME_LENGTH + 1);
    let thrown = "";
    try {
      await loadPlugins({
        pluginNames: ["@acme/pkg"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({ plugin: manifest(tooLong, [toolSet("custom")]) }),
        register: () => {},
      });
    } catch (error) {
      thrown = (error as Error).message;
    }
    for (const fragment of [
      "@acme/pkg",
      `"${tooLong}"`,
      '"name"',
      `${MAX_PLUGIN_NAME_LENGTH} characters`,
      `${tooLong.length}`,
    ]) {
      expect(thrown).toContain(fragment);
    }
  });

  it("accepts a name exactly at the cap", async () => {
    const atCap = "a".repeat(MAX_PLUGIN_NAME_LENGTH);
    const { register, calls } = makeRegister();
    await loadPlugins({
      pluginNames: ["@acme/pkg"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({ plugin: manifest(atCap, [toolSet("custom")]) }),
      register,
    });
    expect(calls.map((c) => c.id)).toEqual([`${atCap}.custom`]);
  });

  it("holds a core plugin to no name cap — its name is never a namespace", async () => {
    const { register } = makeRegister();
    const longCoreName = `@platypus/${"a".repeat(MAX_PLUGIN_NAME_LENGTH)}`;
    await expect(
      loadPlugins({
        pluginNames: [longCoreName],
        builtinPlugins: {
          [longCoreName]: () =>
            Promise.resolve({
              plugin: manifest(longCoreName, [toolSet("custom")]),
            }),
        },
        register,
      }),
    ).resolves.toBeDefined();
  });

  it("accepts a clean slug name and prefixes contribution ids with it", async () => {
    const { register, calls } = makeRegister();
    const { plugins: loaded } = await loadPlugins({
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

describe("loadPlugins — manifest name uniqueness (ADR-0013)", () => {
  it("refuses two plugins sharing a manifest name, naming both package specifiers", async () => {
    const { register } = makeRegister();
    const modules: Record<string, PlatypusPlugin> = {
      "@acme/pkg": manifest("acme", [toolSet("foo")]),
      "@fork/acme-pkg": manifest("acme", [toolSet("bar")]),
    };

    await expect(
      loadPlugins({
        pluginNames: ["@acme/pkg", "@fork/acme-pkg"],
        builtinPlugins: {},
        importPlugin: (name) => Promise.resolve({ plugin: modules[name] }),
        register,
      }),
    ).rejects.toThrow(/"acme".*"@acme\/pkg".*"@fork\/acme-pkg"/s);
  });

  it("refuses before the second plugin's credentials are resolved against the shared block", async () => {
    const { register } = makeRegister();
    const modules: Record<string, PlatypusPlugin> = {
      "@acme/pkg": {
        ...manifest("acme", [toolSet("foo")]),
        credentialsSchema: z.object({ token: z.string() }),
      },
      "@fork/acme-pkg": {
        ...manifest("acme", [toolSet("bar")]),
        credentialsSchema: z.object({ apiKey: z.string() }),
      },
    };

    await expect(
      loadPlugins({
        pluginNames: ["@acme/pkg", "@fork/acme-pkg"],
        builtinPlugins: {},
        importPlugin: (name) => Promise.resolve({ plugin: modules[name] }),
        register,
        env: {
          PLATYPUS_PLUGIN_CONFIG_ACME: '{"credentials":{"token":"secret"}}',
        },
      }),
    ).rejects.toThrow(/"acme".*"@acme\/pkg".*"@fork\/acme-pkg"/s);
  });

  it("covers core plugins too", async () => {
    const { register } = makeRegister();

    await expect(
      loadPlugins({
        pluginNames: ["@platypus/tools-basic", "@platypus/tools-platform"],
        builtinPlugins: {
          "@platypus/tools-basic": () =>
            Promise.resolve({
              plugin: manifest("@platypus/tools", [toolSet("time")]),
            }),
          "@platypus/tools-platform": () =>
            Promise.resolve({
              plugin: manifest("@platypus/tools", [toolSet("agents")]),
            }),
        },
        register,
      }),
    ).rejects.toThrow(
      /"@platypus\/tools".*"@platypus\/tools-basic".*"@platypus\/tools-platform"/s,
    );
  });

  it("reads as a list problem when the same specifier is listed twice", async () => {
    const { register } = makeRegister();

    await expect(
      loadPlugins({
        pluginNames: ["@acme/pkg", "@acme/pkg"],
        builtinPlugins: {},
        importPlugin: () =>
          Promise.resolve({ plugin: manifest("acme", [toolSet("foo")]) }),
        register,
      }),
    ).rejects.toThrow(/"@acme\/pkg".*more than once.*PLATYPUS_PLUGINS/s);
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

    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["@platypus/tools-basic", "@example-org/pkg"],
      builtinPlugins,
      importPlugin,
      register,
    });

    expect(calls.map((c) => c.id)).toEqual(["time", "example.greeting"]);
    expect(loaded[0].toolSetIds).toEqual(["time"]);
    expect(loaded[1].toolSetIds).toEqual(["example.greeting"]);
  });

  it("prefixes third-party sandbox-backend ids too", async () => {
    const { register } = makeRegister();
    const { registerSandbox, calls } = makeSandboxRegister();

    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["@third/infra"],
      builtinPlugins: {},
      importPlugin: () =>
        Promise.resolve({
          plugin: sandboxManifest("acme", [sandboxBackend("cloud")]),
        }),
      register,
      registerSandbox,
    });

    expect(calls.map((c) => c.backend)).toEqual(["acme.cloud"]);
    expect(loaded[0].sandboxBackendIds).toEqual(["acme.cloud"]);
  });

  it("treats a package borrowing an @platypus/* name as third-party (prefixed)", async () => {
    const { register, calls } = makeRegister();
    const importPlugin = vi.fn(() =>
      Promise.resolve({
        plugin: manifest("impostor", [toolSet("kanban")]),
      }),
    );

    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["@platypus/impostor"],
      builtinPlugins: {},
      importPlugin,
      register,
    });

    expect(importPlugin).toHaveBeenCalledWith("@platypus/impostor");
    expect(calls.map((c) => c.id)).toEqual(["impostor.kanban"]);
    expect(loaded[0].origin).toBe("third-party");
  });
});

describe("loadPlugins — example third-party npm package (end to end)", () => {
  it("loads the installed package via dynamic import and namespaces its id", async () => {
    const { register, calls } = makeRegister();

    const { plugins: loaded } = await loadPlugins({
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
    const { logger: baseLogger, lines } = captureLogger("debug");

    await loadPlugins({
      pluginNames: ["@platypus-examples/tool-set"],
      builtinPlugins: {},
      register: registerToolSet,
      baseLogger,
    });

    const set = getToolSet("example.greeting")!;
    expect(set.category).toBe("Examples");
    expect(getToolSet("greeting")).toBeUndefined();

    const tools = await set.buildTurnTools(
      {
        workspaceId: "ws-1",
        agentId: "agent-1",
        orgId: "org-1",
        frontendUrl: "http://localhost:3000",
        userId: "user-1",
        timezone: "UTC",
        sessionId: "chat-1",
        registerCloser: () => {},
      },
      undefined,
      () => {},
    );
    expect(Object.keys(tools)).toEqual(["example__greet"]);
    const result = (await tools.example__greet.execute!(
      { name: "Ada" },
      { toolCallId: "t1", messages: [], context: {} },
    )) as string;
    expect(result).toContain("Ada");

    expect(lines).toContainEqual(
      expect.objectContaining({
        plugin: "example",
        workspaceId: "ws-1",
        agentId: "agent-1",
        level: 20,
      }),
    );
  });

  it("writes nothing when the Operator's LOG_LEVEL excludes the plugin's level", async () => {
    const { logger: baseLogger, lines } = captureLogger("info");
    const { register, calls } = makeRegister();

    await loadPlugins({
      pluginNames: ["@platypus-examples/tool-set"],
      builtinPlugins: {},
      register,
      baseLogger,
    });

    await calls[0].registration.buildTurnTools(
      {
        workspaceId: "ws-1",
        agentId: "agent-1",
        orgId: "org-1",
        frontendUrl: "http://localhost:3000",
        userId: "user-1",
        timezone: "UTC",
        sessionId: "chat-1",
        registerCloser: () => {},
      },
      undefined,
      () => {},
    );

    expect(lines).toEqual([]);
  });
});
