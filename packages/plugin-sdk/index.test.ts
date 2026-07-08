import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import {
  PLUGIN_API_VERSION,
  type PlatypusPlugin,
  type ToolSetContribution,
} from "./index.ts";

describe("@platypuschat/plugin-sdk", () => {
  it("pins the plugin API version", () => {
    expect(PLUGIN_API_VERSION).toBe(1);
  });

  it("accepts a well-formed manifest with a static-map tool set", () => {
    const staticSet: ToolSetContribution = {
      id: "example",
      name: "Example",
      category: "Utilities",
      tools: {
        echo: tool({
          description: "Echo the input",
          inputSchema: z.object({ text: z.string() }),
          execute: ({ text }) => text,
        }),
      },
    };

    const plugin: PlatypusPlugin = {
      name: "@example/plugin",
      version: "0.1.0",
      apiVersion: PLUGIN_API_VERSION,
      contributes: { toolSets: [staticSet] },
    };

    expect(plugin.name).toBe("@example/plugin");
    expect(plugin.contributes.toolSets).toHaveLength(1);
    expect(plugin.contributes.toolSets?.[0].id).toBe("example");
  });

  it("accepts a manifest with a factory tool set and config schemas", () => {
    const plugin: PlatypusPlugin = {
      name: "@example/scoped",
      version: "0.1.0",
      apiVersion: PLUGIN_API_VERSION,
      configSchema: z.object({ region: z.string() }),
      credentialsSchema: z.object({ token: z.string() }),
      contributes: {
        toolSets: [
          {
            id: "scoped",
            name: "Scoped",
            category: "Productivity",
            description: "Needs runtime scope",
            tools: (ctx) => {
              expect(ctx.workspaceId).toBeDefined();
              return {};
            },
          },
        ],
      },
    };

    expect(typeof plugin.contributes.toolSets?.[0].tools).toBe("function");
    expect(plugin.configSchema).toBeDefined();
  });
});
