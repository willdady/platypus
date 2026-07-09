import { describe, it, expect } from "vitest";
import {
  PLUGIN_API_VERSION,
  type SandboxBackendContribution,
} from "@platypuschat/plugin-sdk";
import { plugin } from "./index.ts";
import { readAllowedDockerNetworks } from "./backend.ts";
import { loadPlugins } from "../loader.ts";
import { getPluginConfig, setLoadedPlugins } from "../registry.ts";
import { getSandboxBackend } from "../../sandbox/index.ts";

describe("@platypus/docker plugin manifest", () => {
  it("declares its identity and API version", () => {
    expect(plugin.name).toBe("@platypus/docker");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it("declares a plugin-level configSchema for the operator allowlist", () => {
    // The network allowlist moved onto PLATYPUS_PLUGIN_CONFIG (ADR-0013), so the
    // manifest now declares a plugin-level configSchema. No credentialsSchema —
    // Docker has no plugin-level secrets.
    expect(plugin.configSchema).toBeDefined();
    expect(plugin.credentialsSchema).toBeUndefined();
    // It defaults allowedNetworks to [] (default-deny) and is strict.
    const parsed = plugin.configSchema!.parse({});
    expect(parsed).toEqual({ allowedNetworks: [] });
    expect(plugin.configSchema!.safeParse({ unknownKey: 1 }).success).toBe(
      false,
    );
  });

  it("contributes the docker sandbox backend with the unprefixed core id", () => {
    const backends = plugin.contributes.sandboxBackends ?? [];
    expect(backends).toHaveLength(1);

    const [docker] = backends;
    expect(docker.backend).toBe("docker");
    expect(docker.name).toBe("Local Docker");
    expect(typeof docker.create).toBe("function");
    // The per-Workspace configSchema is a factory of the plugin config (resolved
    // by the loader at load); credentials stay a plain schema.
    expect(typeof docker.configSchema).toBe("function");
    expect(docker.credentialsSchema).toBeDefined();
  });

  it("registers the docker backend into the core registry when loaded", async () => {
    // The registry is module-global; vitest isolates modules per file, so this
    // load doesn't leak into other test files. Exercise the real plugin path:
    // loader → registerSandboxBackend → getSandboxBackend.
    expect(getSandboxBackend("docker")).toBeUndefined();

    const loaded = await loadPlugins({ pluginNames: ["@platypus/docker"] });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      name: "@platypus/docker",
      origin: "core",
      sandboxBackendIds: ["docker"],
    });

    const registration = getSandboxBackend("docker");
    expect(registration?.backend).toBe("docker");
    expect(registration?.name).toBe("Local Docker");
    expect(typeof registration?.create).toBe("function");

    // The loader resolved the factory-form configSchema into a concrete schema
    // (safeParse present). With no plugin config supplied, allowedNetworks
    // defaults to [] so any non-empty networks entry is rejected — default-deny
    // preserved (ADR-0005).
    expect(typeof registration?.configSchema.safeParse).toBe("function");
    expect(registration?.configSchema.safeParse({ networks: [] }).success).toBe(
      true,
    );
    expect(
      registration?.configSchema.safeParse({ networks: ["shared"] }).success,
    ).toBe(false);
  });

  it("honours a PLATYPUS_PLUGIN_CONFIG allowlist end to end", async () => {
    // Full chain through the real builtin plugin: PLATYPUS_PLUGIN_CONFIG →
    // boot-resolved plugin config → per-Workspace configSchema (save-time
    // validation) and the registry-backed /networks source. Uses a capturing
    // registerSandbox so this second load doesn't collide with the module-global
    // registry seeded by the tests above.
    const captured: SandboxBackendContribution[] = [];
    const loaded = await loadPlugins({
      pluginNames: ["@platypus/docker"],
      registerSandbox: (c) => captured.push(c),
      pluginConfig: {
        "@platypus/docker": { config: { allowedNetworks: ["shared"] } },
      },
    });

    // Save-time validation reflects the operator allowlist: in-list passes,
    // out-of-list is rejected (ADR-0005), all at config-save time.
    const schema = captured[0].configSchema as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ networks: ["shared"] }).success).toBe(true);
    expect(schema.safeParse({ networks: ["not-allowed"] }).success).toBe(false);

    // The /networks endpoint source: resolved config flows through the registry
    // and the docker helper yields the allowlist.
    setLoadedPlugins(loaded);
    expect(getPluginConfig("@platypus/docker")).toEqual({
      allowedNetworks: ["shared"],
    });
    expect(
      readAllowedDockerNetworks(getPluginConfig("@platypus/docker")),
    ).toEqual(["shared"]);
  });
});
