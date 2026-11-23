import { describe, it, expect } from "vitest";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import { plugin } from "./index.ts";
import { loadPlugins } from "../loader.ts";
import { getSandboxBackend } from "../../sandbox/index.ts";

describe("@platypus/daytona plugin manifest", () => {
  it("declares its identity and API version", () => {
    expect(plugin.name).toBe("@platypus/daytona");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it("registers the daytona backend into the core registry when loaded", async () => {
    expect(getSandboxBackend("daytona")).toBeUndefined();

    const { plugins: loaded } = await loadPlugins({
      pluginNames: ["@platypus/daytona"],
      env: {
        PLATYPUS_PLUGIN_CONFIG_DAYTONA: '{"credentials":{"apiKey":"dtn_test"}}',
      },
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      name: "@platypus/daytona",
      origin: "core",
      sandboxBackendIds: ["daytona"],
    });

    const registration = getSandboxBackend("daytona");
    expect(registration?.backend).toBe("daytona");
    expect(registration?.name).toBe("Daytona");
    expect(typeof registration?.create).toBe("function");
  });
});
