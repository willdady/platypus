import { describe, it, expect } from "vitest";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import { plugin } from "./index.ts";
import { loadPlugins } from "../loader.ts";
import { getSandboxBackend } from "../../sandbox/index.ts";

describe("@platypus/ssh plugin manifest", () => {
  it("declares its identity and API version", () => {
    expect(plugin.name).toBe("@platypus/ssh");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it("contributes the ssh sandbox backend with the unprefixed core id", () => {
    const backends = plugin.contributes.sandboxBackends ?? [];
    expect(backends).toHaveLength(1);

    const [ssh] = backends;
    expect(ssh.backend).toBe("ssh");
    expect(ssh.name).toBe("SSH (Remote Host)");
    expect(typeof ssh.create).toBe("function");
    expect(ssh.configSchema).toBeDefined();
    expect(ssh.credentialsSchema).toBeDefined();
  });

  it("registers the ssh backend into the core registry when loaded", async () => {
    // The registry is module-global; vitest isolates modules per file, so this
    // load doesn't leak into other test files. Exercise the real plugin path:
    // loader → registerSandboxBackend → getSandboxBackend.
    expect(getSandboxBackend("ssh")).toBeUndefined();

    const loaded = await loadPlugins({ pluginNames: ["@platypus/ssh"] });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      name: "@platypus/ssh",
      origin: "core",
      sandboxBackendIds: ["ssh"],
    });

    const registration = getSandboxBackend("ssh");
    expect(registration?.backend).toBe("ssh");
    expect(registration?.name).toBe("SSH (Remote Host)");
    expect(typeof registration?.create).toBe("function");
  });
});
