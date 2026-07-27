import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import {
  OLDEST_SUPPORTED_API_VERSION,
  PLUGIN_API_VERSION,
  type PlatypusPlugin,
  type PluginConfigContext,
  type SandboxBackendContribution,
  type ToolSetContribution,
  type WebBackendContribution,
} from "./index.ts";

describe("@platypuschat/plugin-sdk", () => {
  it("pins the plugin API version", () => {
    expect(PLUGIN_API_VERSION).toBe(1);
  });

  it("supports one previous major (N and N−1), floored at 1 (no phantom v0)", () => {
    expect(OLDEST_SUPPORTED_API_VERSION).toBe(
      Math.max(1, PLUGIN_API_VERSION - 1),
    );
    // There is no major 0, so the oldest supported major is never below 1.
    expect(OLDEST_SUPPORTED_API_VERSION).toBeGreaterThanOrEqual(1);
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

  it("injects a shared PluginConfigContext into factories (optional to consume)", () => {
    const shared: PluginConfigContext<
      { region: string },
      { apiToken: string }
    > = {
      config: { region: "eu" },
      credentials: { apiToken: "tok" },
    };

    // A tool-set factory may accept the appended `plugin` argument…
    const toolSet: ToolSetContribution = {
      id: "scoped",
      name: "Scoped",
      category: "Productivity",
      tools: (_ctx, plugin) => {
        expect(plugin?.credentials).toEqual({ apiToken: "tok" });
        return {};
      },
    };
    (toolSet.tools as (ctx: unknown, plugin: PluginConfigContext) => unknown)(
      {
        workspaceId: "w",
        agentId: "a",
        orgId: "o",
        frontendUrl: undefined,
        userId: "u",
      },
      shared,
    );

    // …and a Sandbox-backend factory takes it as a third argument, sharing the
    // same block. A two-argument factory (ignoring `plugin`) still type-checks.
    const backend: SandboxBackendContribution = {
      backend: "cloud",
      name: "Cloud",
      configSchema: z.object({}),
      credentialsSchema: z.object({}),
      create: (_config, _credentials, plugin) => {
        expect(plugin).toBe(shared);
        return {} as never;
      },
    };
    backend.create({}, {}, shared);
  });

  it("accepts a web-backend contribution supplying executors only", async () => {
    const contribution: WebBackendContribution = {
      backend: "searx",
      name: "SearXNG",
      timeoutMs: 5_000,
      createExecutors: (ctx, plugin) => {
        expect(ctx.workspaceId).toBe("w");
        expect(plugin?.credentials).toEqual({ apiKey: "k" });
        return {
          web_search: ({ query }) => ({
            query,
            results: [{ title: "Hit", url: "https://example.com/" }],
            answer: "42",
          }),
          read_url: ({ url }) => ({
            content: "page",
            url,
            contentType: "text/markdown",
          }),
        };
      },
    };

    const plugin: PlatypusPlugin = {
      name: "acme",
      version: "0.1.0",
      apiVersion: PLUGIN_API_VERSION,
      contributes: { webBackends: [contribution] },
    };
    expect(plugin.contributes.webBackends).toHaveLength(1);

    // The executors are plain functions, not AI SDK Tools: core owns the schemas,
    // the caps, the slicing, the timeout, and the egress guard (ADR-0014).
    const executors = await contribution.createExecutors(
      { orgId: "o", workspaceId: "w", userId: "u" },
      { config: {}, credentials: { apiKey: "k" } },
    );
    expect((await executors.web_search({ query: "q" })).results).toHaveLength(
      1,
    );
    expect(typeof executors.read_url).toBe("function");
  });

  it("accepts a search-only web backend (read_url is optional)", () => {
    const contribution: WebBackendContribution = {
      backend: "searx",
      name: "SearXNG",
      // No read_url: a search-only Operator (no browser service) omits it and the
      // model simply gets search that turn.
      createExecutors: () => ({
        web_search: () => ({ query: "q", results: [] }),
      }),
    };

    expect(contribution.timeoutMs).toBeUndefined();
  });
});
