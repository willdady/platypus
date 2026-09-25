import { beforeAll, describe, it, expect, vi } from "vitest";
import type { ToolSetContext } from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";

// The domain tool sets transitively import the db and a few services; mock them
// so importing the manifest (and resolving its factories) needs no live
// Postgres. Factories return AI SDK tool maps without touching the db until a
// tool's `execute` runs, so these stubs are enough.
vi.mock("../../index.ts", () => ({ db: {} }));
vi.mock("../../services/event-dispatch.ts", () => ({ dispatchEvent: vi.fn() }));
vi.mock("../../services/sub-agent-validation.ts", () => ({
  validateSubAgentAssignment: vi.fn(),
}));
vi.mock("../../storage/index.ts", () => ({ getStorage: vi.fn() }));

import { plugin } from "./index.ts";
import { loadPlugins, type LoadedPlugin } from "../loader.ts";
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
  registerCloser: () => {},
};

describe("@platypus/tools-platform plugin manifest", () => {
  it("declares its identity and API version", () => {
    expect(plugin.name).toBe("@platypus/tools-platform");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it("exposes every tool set as a context factory", () => {
    for (const ts of plugin.contributes.toolSets ?? []) {
      expect(typeof ts.tools).toBe("function");
    }
  });
});

describe("@platypus/tools-platform — loaded into the core registry", () => {
  // Module-global registry; vitest isolates modules per file so this doesn't
  // leak. Exercise the real path: loader → registerToolSet → getToolSet.
  const registeredIds = () => getToolSets().map((s) => s.id);
  let before: string[];
  let loaded: LoadedPlugin[];

  beforeAll(async () => {
    before = registeredIds();
    ({ plugins: loaded } = await loadPlugins({
      pluginNames: ["@platypus/tools-platform"],
    }));
  });

  it("registers all eight domain tool sets with bare ids", () => {
    expect(before.filter((id) => EXPECTED_IDS.includes(id))).toEqual([]);
    expect(loaded).toEqual([
      expect.objectContaining({
        name: "@platypus/tools-platform",
        origin: "core",
        toolSetIds: EXPECTED_IDS,
      }),
    ]);
    expect(registeredIds()).toEqual(expect.arrayContaining(EXPECTED_IDS));
  });

  it("resolves each tool set to a non-empty tool map at chat-turn time", async () => {
    for (const id of EXPECTED_IDS) {
      const tools = await getToolSet(id)!.buildTurnTools(ctx);
      expect(Object.keys(tools).length).toBeGreaterThan(0);
    }
  });

  it("resolves the read/write agent-management split tools as before", async () => {
    const discoveryTools =
      await getToolSet("agent-discovery")!.buildTurnTools(ctx);
    expect(Object.keys(discoveryTools).sort()).toEqual(
      ["getAgent", "listAgents", "listModelProviders", "listToolSets"].sort(),
    );

    const managementTools =
      await getToolSet("agent-management")!.buildTurnTools(ctx);
    expect(Object.keys(managementTools).sort()).toEqual(
      ["createAgent", "deleteAgent", "updateAgent"].sort(),
    );
  });
});
