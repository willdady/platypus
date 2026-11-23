import { afterEach, describe, it, expect, vi } from "vitest";
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("declares its identity and API version", () => {
    expect(plugin.name).toBe("@platypus/docker");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it("declares a plugin-level configSchema for the operator allowlist", () => {
    expect(plugin.credentialsSchema).toBeUndefined();
    const parsed = plugin.configSchema.parse({});
    expect(parsed).toEqual({ allowedNetworks: [] });
    expect(plugin.configSchema.safeParse({ unknownKey: 1 }).success).toBe(
      false,
    );
  });

  it("registers the docker backend into the core registry when loaded", async () => {
    expect(getSandboxBackend("docker")).toBeUndefined();

    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["@platypus/docker"],
    });

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

    expect(typeof registration?.configSchema.safeParse).toBe("function");
    expect(registration?.configSchema.safeParse({ networks: [] }).success).toBe(
      true,
    );
    expect(
      registration?.configSchema.safeParse({ networks: ["shared"] }).success,
    ).toBe(false);
  });

  it("honours a PLATYPUS_PLUGIN_CONFIG_DOCKER allowlist end to end", async () => {
    const captured: SandboxBackendContribution[] = [];
    const loaded = await loadPlugins({
      pluginNames: ["@platypus/docker"],
      registerSandbox: (c) => captured.push(c),
      env: {
        PLATYPUS_PLUGIN_CONFIG_DOCKER:
          '{"config":{"allowedNetworks":["shared"]}}',
      },
    });

    const schema = captured[0].configSchema as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ networks: ["shared"] }).success).toBe(true);
    expect(schema.safeParse({ networks: ["not-allowed"] }).success).toBe(false);

    setLoadedPlugins(loaded);
    expect(getPluginConfig("@platypus/docker")).toEqual({
      allowedNetworks: ["shared"],
    });
    expect(
      readAllowedDockerNetworks(getPluginConfig("@platypus/docker")),
    ).toEqual(["shared"]);
  });

  it("reads its allowlist from PLATYPUS_PLUGIN_CONFIG_DOCKER", async () => {
    vi.stubEnv(
      "PLATYPUS_PLUGIN_CONFIG_DOCKER",
      '{"config":{"allowedNetworks":["shared"]}}',
    );
    const loaded = await loadPlugins({
      pluginNames: ["@platypus/docker"],
      registerSandbox: () => {},
    });
    setLoadedPlugins(loaded);
    expect(getPluginConfig("@platypus/docker")).toEqual({
      allowedNetworks: ["shared"],
    });
  });
});
