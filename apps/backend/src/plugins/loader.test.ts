import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import { z } from "zod";
import {
  OLDEST_SUPPORTED_API_VERSION,
  PLUGIN_API_VERSION,
  type PlatypusPlugin,
  type PluginConfigContext,
  type SandboxBackend,
  type SandboxBackendContribution,
  type ToolSetContribution,
  type WebBackendContribution,
} from "@platypuschat/plugin-sdk";
import {
  MAX_WEB_TIMEOUT_MS,
  type WebBackendRegistration,
} from "../web-backends/index.ts";
import {
  loadPlugins,
  parsePluginConfig,
  parsePluginList,
  type PluginLoggerParent,
} from "./loader.ts";
import { plugin as examplePlugin } from "./example/index.ts";
import {
  registerToolSet,
  getToolSet,
  type ToolSetRegistration,
} from "../tools/index.ts";

// A capturing `register` and the builtin/import module shapes the loader expects.
const makeRegister = () => {
  const calls: Array<{ id: string; registration: ToolSetRegistration }> = [];
  const register = (id: string, registration: ToolSetRegistration) => {
    calls.push({ id, registration });
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

// Every deploy-time block the loader builds now carries a plugin-bound logger.
// The assertions below still spell the block out in full — `expect.anything()`
// widened once here, because it is typed `any` and would be an unsafe
// assignment at each site. What the logger IS is asserted on its own, further
// down.
const A_LOGGER_MATCHER = expect.anything() as unknown;

// Core's own logger, at whatever level an Operator's LOG_LEVEL would have set,
// writing its parsed JSON into `lines` instead of stdout. Same library and same
// `child()` seam the loader uses by default, only with somewhere to read the
// output back from — so what these tests assert is what an Operator would see.
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

// A capturing `registerWeb` for the Web-search-backend extension point. It takes
// core's composed registration, not the raw contribution.
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
  apiVersion: 1,
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
    const { plugins: loaded } = await loadPlugins({
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
    // The registry serves catalog annotations from these maps rather than
    // re-deriving them from each plugin's id arrays (ADR-0013 observability).
    // One map per Extension point: a Tool set and a backend may share a bare id.
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

    const { plugins: loaded } = await loadPlugins({
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

  // Contribution shape, id, and name are the shared pipeline's checks, covered
  // once in `contribution-pipeline.test.ts`. What is left here is what the
  // Tool-set point itself demands of a contribution.
  it.each([
    [
      "a missing category",
      { id: "broken", name: "Broken", tools: {} },
      /@platypus\/bad.*tool set "broken".*non-empty "category"/s,
    ],
    [
      "a whitespace-only category",
      { id: "broken", name: "Broken", category: "   ", tools: {} },
      /@platypus\/bad.*tool set "broken".*non-empty "category"/s,
    ],
    [
      "missing tools",
      { id: "broken", name: "Broken", category: "Test" },
      /@platypus\/bad.*tool set "broken".*"tools" object or function/s,
    ],
    [
      "an array tools",
      { id: "broken", name: "Broken", category: "Test", tools: [] },
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
                  apiVersion: 1,
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
      },
    ]);
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

  // `sandboxBackends` being an array is checked above, and contribution shape,
  // id, and name are the shared pipeline's checks (covered once in
  // `contribution-pipeline.test.ts`). What is left here is what the
  // Sandbox-backend point itself demands — each case previously surfaced far
  // from its cause: an unattributed TypeError at boot, or a 500 on an Operator's
  // sandbox form.
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
    // A factory-form configSchema is third-party code narrowing a config block
    // it owns, so it can throw before it ever returns a schema — the shape check
    // downstream only sees a non-schema *return*. Without attribution here, a
    // plugin assuming an Operator supplied `config.region` aborts boot with a
    // bare `Cannot read properties of undefined` naming nothing.
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
      // A core plugin name: a third-party one is slug-checked before the loop
      // these cases exercise, which would mask the error under test.
      await expect(
        loadPlugins({
          pluginNames: ["@platypus/bad"],
          builtinPlugins: {
            "@platypus/bad": () =>
              Promise.resolve({
                plugin: {
                  name: "@platypus/bad",
                  version: "0.1.0",
                  apiVersion: 1,
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

  it("resolves a factory-form configSchema against the plugin config at load", async () => {
    const { register } = makeRegister();
    const { registerSandbox, calls } = makeSandboxRegister();

    // A backend whose per-Workspace configSchema is a FACTORY of the plugin's
    // resolved deploy-time config: it closes over an operator allowlist and
    // rejects out-of-allowlist values (mirrors @platypus/docker). The loader
    // must resolve it to a concrete schema before registering — the registry and
    // core's static safeParse consumers only ever see plain schemas.
    const factoryBackend: SandboxBackendContribution = {
      backend: "fenced",
      name: "Fenced",
      configSchema: (pluginConfig) => {
        const { allowed } = pluginConfig as { allowed: string[] };
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
            apiVersion: 1,
            configSchema: z.object({
              allowed: z.array(z.string()).default([]),
            }),
            contributes: { sandboxBackends: [factoryBackend] },
          } satisfies PlatypusPlugin,
        }),
      register,
      registerSandbox,
      pluginConfig: { fenced: { config: { allowed: ["ok"] } } },
    });

    const [registered] = calls;
    // Registered as a CONCRETE schema (the factory is resolved away), reflecting
    // the resolved plugin config.
    expect(typeof registered.configSchema).not.toBe("function");
    const schema = registered.configSchema as z.ZodType;
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

    // A plain schema passes through by identity — append-only compatibility.
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
    // What lands in the registry is core's composed builder, not the raw
    // contribution: the model-facing surface is core-owned (ADR-0014).
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
              apiVersion: 1,
              contributes: { webBackends: {} },
            },
          }),
        register,
        registerWeb: () => {},
      }),
    ).rejects.toThrow(/@bad\/plugin.*webBackends.*array/s);
  });

  // Contribution shape, id, and name are the shared pipeline's checks, covered
  // once in `contribution-pipeline.test.ts`. What is left here is what the
  // Web-backend point itself demands of a contribution.
  it("aborts (fail-loud) when a contribution has no createExecutors function", async () => {
    const { register } = makeRegister();
    // The TS type requires it; a third-party JS plugin can still omit it, and
    // boot — not a live turn — is where that is caught.
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
            apiVersion: 1,
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
      pluginConfig: {
        acme: {
          config: { endpoint: "https://searx.internal" },
          credentials: { apiKey: "sk-test" },
        },
      },
    });

    // Core's own context; `providerId` is stripped before the plugin-facing
    // call, so the factory sees only the ADR-0014 shape.
    const pluginCtx = { orgId: "org-1", workspaceId: "ws-1", userId: "user-1" };
    await calls[0].buildTurnTools({ ...pluginCtx, providerId: "provider-1" });

    expect(createExecutors).toHaveBeenCalledWith(pluginCtx, {
      config: { endpoint: "https://searx.internal" },
      credentials: { apiKey: "sk-test" },
      logger: A_LOGGER_MATCHER,
    });
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
    const registered: Record<string, ToolSetRegistration> = {};
    const register = (id: string, registration: ToolSetRegistration) => {
      registered[id] = registration;
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
    await registered["acmecloud.managed"].buildTurnTools({
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

    await registered["acmecloud.managed"].buildTurnTools({
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
    const registered: Record<string, ToolSetRegistration> = {};

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
      register: (id, registration) => {
        registered[id] = registration;
      },
    });

    await registered["noschema.plain"].buildTurnTools({
      workspaceId: "w",
      agentId: "a",
      orgId: "o",
      frontendUrl: undefined,
      userId: "u",
    });

    expect(seenPlugin).toEqual({
      config: undefined,
      credentials: undefined,
      logger: A_LOGGER_MATCHER,
    });
  });
});

describe("loadPlugins — plugin logger injection", () => {
  // A plugin contributing to all three Extension points, each factory recording
  // the block it was handed and writing one line through it.
  const loggingManifest = (
    name: string,
    seen: Record<string, PluginConfigContext | undefined>,
  ): PlatypusPlugin => ({
    name,
    version: "0.1.0",
    apiVersion: 1,
    contributes: {
      toolSets: [
        {
          id: "tools",
          name: "Tools",
          category: "Test",
          tools: (_ctx, plugin) => {
            seen.toolSet = plugin;
            plugin?.logger?.info({ point: "toolSet" }, "resolving tools");
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
            plugin?.logger?.info({ point: "sandbox" }, "creating adapter");
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
            plugin?.logger?.info({ point: "web" }, "building executors");
            return { web_search: () => ({ query: "q", results: [] }) };
          },
        },
      ],
    },
  });

  // Drive every factory the way core does at turn time, so what is asserted is
  // what a plugin author's own code would actually receive.
  const invokeAllFactories = async (opts: {
    pluginName: string;
    baseLogger: PluginLoggerParent;
    seen: Record<string, PluginConfigContext | undefined>;
  }) => {
    const registered: Record<string, ToolSetRegistration> = {};
    const sandboxCalls: SandboxBackendContribution[] = [];
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

    await registered[`${opts.pluginName}.tools`].buildTurnTools({
      workspaceId: "w",
      agentId: "a",
      orgId: "o",
      frontendUrl: undefined,
      userId: "u",
    });
    sandboxCalls[0].create({}, {});
    await webCalls[0].buildTurnTools({
      orgId: "o",
      workspaceId: "w",
      userId: "u",
      providerId: "p",
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

    // One child per plugin, shared by object identity with the rest of the
    // deploy-time block — no per-Extension-point plumbing.
    expect(seen.toolSet?.logger).toBeDefined();
    expect(seen.sandbox?.logger).toBe(seen.toolSet?.logger);
    expect(seen.web?.logger).toBe(seen.toolSet?.logger);

    // Every line landed in core's stream, attributed to the manifest name.
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.point)).toEqual(["toolSet", "sandbox", "web"]);
    for (const line of lines) {
      expect(line.plugin).toBe("acme");
      expect(line.msg).toEqual(expect.any(String));
    }
  });

  it("suppresses a plugin line the Operator's LOG_LEVEL excludes", async () => {
    // The plugin logs at `info`; the deployment is set to `warn`. Nothing is
    // written — the plugin's lines obey LOG_LEVEL like core's own.
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
  // Proves the documented example plugin wires one shared credential block into
  // BOTH its Sandbox backend and its management Tool set (ADR-0013).
  it("shares one credential block across its two contributions", async () => {
    const registered: Record<string, ToolSetRegistration> = {};
    const sandboxCalls: SandboxBackendContribution[] = [];

    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["example-cloud-sandbox"],
      builtinPlugins: {},
      importPlugin: () => Promise.resolve({ plugin: examplePlugin }),
      register: (id, registration) => {
        registered[id] = registration;
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
    const tools = (await registered[
      "example-cloud-sandbox.management"
    ].buildTurnTools({
      workspaceId: "w",
      agentId: "a",
      orgId: "o",
      frontendUrl: undefined,
      userId: "u",
    })) as unknown as Record<
      string,
      { execute: (i: unknown) => Promise<string> }
    >;
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

// `apps/docs/content/extending/your-first-plugin.mdx` walks a reader through
// listing `@platypus-examples/tool-set` in PLATYPUS_PLUGINS and then tells them
// exactly what to look for on two screens. Every string it names is asserted
// here, against the real package resolved by the real dynamic `import()` — so a
// rename breaks a test rather than sending a first-time plugin author hunting a
// row that no longer exists.
describe("loadPlugins — the documented quickstart package", () => {
  it("resolves @platypus-examples/tool-set and registers example.greeting", async () => {
    const { register, calls } = makeRegister();

    // No `importPlugin` override: this exercises the default dynamic import, the
    // same path a deployment takes for any installed third-party package.
    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["@platypus-examples/tool-set"],
      builtinPlugins: {},
      register,
    });

    // Checkpoint 1 — the row in Organization settings → Plugins is labelled with
    // the manifest `name`, NOT the package specifier the Operator installed.
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe("example");
    expect(loaded[0].version).toBe("0.1.0");
    expect(loaded[0].origin).toBe("third-party");
    expect(loaded[0].toolSetIds).toEqual(["example.greeting"]);

    // Checkpoint 2 — the Agent form's Tools card groups by `category` and labels
    // the switch with `name`, so those are the two strings the reader hunts for.
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

    // Core keeps its bare id; third-party is `${manifest.name}.${id}`.
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

    const { plugins: loaded } = await loadPlugins({
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
    // The package logs at `debug`, so the stream is set to admit it — the same
    // thing an Operator does with LOG_LEVEL when they want a plugin's detail.
    const { logger: baseLogger, lines } = captureLogger("debug");

    await loadPlugins({
      pluginNames: ["@platypus-examples/tool-set"],
      builtinPlugins: {},
      register: registerToolSet,
      baseLogger,
    });

    // Chat-turn resolution walks the tool-set registry by id (ADR-0013): the
    // example plugin is reachable only under its namespaced id.
    const set = getToolSet("example.greeting")!;
    expect(set.category).toBe("Examples");
    expect(getToolSet("greeting")).toBeUndefined();

    const tools = await set.buildTurnTools({
      workspaceId: "ws-1",
      agentId: "agent-1",
      orgId: "org-1",
      frontendUrl: undefined,
      userId: "user-1",
    });
    const result = (await tools.greet.execute!(
      { name: "Ada" },
      { toolCallId: "t1", messages: [], context: {} },
    )) as string;
    expect(result).toContain("Ada");

    // The whole third-party logging path, through the real published package:
    // the line the plugin wrote is in core's stream, attributed to its manifest
    // name, with the fields it supplied intact.
    expect(lines).toContainEqual(
      expect.objectContaining({
        plugin: "example",
        workspaceId: "ws-1",
        agentId: "agent-1",
        level: 20, // debug
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

    await calls[0].registration.buildTurnTools({
      workspaceId: "ws-1",
      agentId: "agent-1",
      orgId: "org-1",
      frontendUrl: undefined,
      userId: "user-1",
    });

    expect(lines).toEqual([]);
  });
});
