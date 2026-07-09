import { describe, it, expect, vi } from "vitest";
import type { ToolSetContext } from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";

// The domain tool sets transitively import the db and a few services; mock them
// so importing the manifest (and resolving its factories) needs no live
// Postgres. Factories return AI SDK tool maps without touching the db until a
// tool's `execute` runs, so these stubs are enough.
vi.mock("../../index.ts", () => ({ db: {} }));
vi.mock("../../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../services/event-dispatch.ts", () => ({ dispatchEvent: vi.fn() }));
vi.mock("../../services/sub-agent-validation.ts", () => ({
  validateSubAgentAssignment: vi.fn(),
}));
vi.mock("../../storage/index.ts", () => ({ getStorage: vi.fn() }));

import { plugin } from "./index.ts";
import { loadPlugins } from "../loader.ts";
import { getToolSet, getToolSets } from "../../tools/index.ts";

const EXPECTED_IDS = [
  "kanban",
  "dashboards",
  "triggers",
  "agent-discovery",
  "skill-management",
  "agent-management",
  "notifications",
  "memory",
];

const ctx: ToolSetContext = {
  workspaceId: "ws-1",
  agentId: "a-1",
  orgId: "org-1",
  frontendUrl: "http://localhost:3000",
  userId: "u-1",
};

describe("@platypus/tools-platform plugin manifest", () => {
  it("declares its identity and API version", () => {
    expect(plugin.name).toBe("@platypus/tools-platform");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it("contributes the domain tool sets with unprefixed core ids", () => {
    const ids = (plugin.contributes.toolSets ?? []).map((t) => t.id);
    expect(ids).toEqual(EXPECTED_IDS);
  });

  it("exposes every tool set as a context factory", () => {
    for (const ts of plugin.contributes.toolSets ?? []) {
      expect(typeof ts.tools).toBe("function");
    }
  });
});

describe("@platypus/tools-platform — loaded into the core registry", () => {
  it("registers all eight domain tool sets with bare ids", async () => {
    // Module-global registry; vitest isolates modules per file so this doesn't
    // leak. Exercise the real path: loader → registerToolSet → getToolSet.
    for (const id of EXPECTED_IDS) {
      expect(getToolSets()).not.toHaveProperty(id);
    }

    const loaded = await loadPlugins({
      pluginNames: ["@platypus/tools-platform"],
    });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      name: "@platypus/tools-platform",
      origin: "core",
      toolSetIds: EXPECTED_IDS,
    });

    for (const id of EXPECTED_IDS) {
      expect(getToolSets()).toHaveProperty(id);
    }
  });

  it("resolves each tool set's factory to a non-empty tool map at chat-turn time", () => {
    for (const id of EXPECTED_IDS) {
      const set = getToolSet(id);
      expect(typeof set.tools).toBe("function");
      const tools =
        typeof set.tools === "function" ? set.tools(ctx) : set.tools;
      expect(Object.keys(tools).length).toBeGreaterThan(0);
    }
  });

  it("resolves the read/write agent-management split tools as before", () => {
    const discovery = getToolSet("agent-discovery");
    const discoveryTools =
      typeof discovery.tools === "function"
        ? discovery.tools(ctx)
        : discovery.tools;
    expect(Object.keys(discoveryTools).sort()).toEqual(
      ["getAgent", "listAgents", "listModelProviders", "listToolSets"].sort(),
    );

    const management = getToolSet("agent-management");
    const managementTools =
      typeof management.tools === "function"
        ? management.tools(ctx)
        : management.tools;
    expect(Object.keys(managementTools).sort()).toEqual(
      ["createAgent", "deleteAgent", "updateAgent"].sort(),
    );
  });
});
