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

  it("registers the ssh backend into the core registry when loaded", async () => {
    expect(getSandboxBackend("ssh")).toBeUndefined();

    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["@platypus/ssh"],
    });

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
