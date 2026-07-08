import { describe, it, expect } from "vitest";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import { plugin } from "./index.ts";
import { loadPlugins } from "../loader.ts";
import { getSandboxBackend } from "../../sandbox/index.ts";

describe("@platypus/docker plugin manifest", () => {
  it("declares its identity and API version", () => {
    expect(plugin.name).toBe("@platypus/docker");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it("contributes the docker sandbox backend with the unprefixed core id", () => {
    const backends = plugin.contributes.sandboxBackends ?? [];
    expect(backends).toHaveLength(1);

    const [docker] = backends;
    expect(docker.backend).toBe("docker");
    expect(docker.name).toBe("Local Docker");
    expect(typeof docker.create).toBe("function");
    // Schemas are present so the loader can validate per-Workspace config.
    expect(docker.configSchema).toBeDefined();
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
  });
});
