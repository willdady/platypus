import { describe, it, expect, vi } from "vitest";

// Mock the db used by transitive imports (kanban, trigger, etc.)
vi.mock("../index.ts", () => ({
  db: {},
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../services/event-dispatch.ts", () => ({
  dispatchEvent: vi.fn(),
}));

vi.mock("../services/sub-agent-validation.ts", () => ({
  validateSubAgentAssignment: vi.fn(),
}));

vi.mock("../storage/index.ts", () => ({
  getStorage: vi.fn(),
}));

import { getToolSets, getToolSet, registerToolSet } from "./index.ts";

describe("Tool Set Registry", () => {
  describe("getToolSets", () => {
    it("returns all registered tool sets", () => {
      const sets = getToolSets();
      expect(Object.keys(sets).length).toBeGreaterThan(0);
    });

    it("includes the expected built-in tool sets", () => {
      const sets = getToolSets();
      expect(sets).toHaveProperty("math-conversions");
      expect(sets).toHaveProperty("time");
      expect(sets).toHaveProperty("web-fetch");
      expect(sets).toHaveProperty("kanban");
      expect(sets).toHaveProperty("triggers");
      expect(sets).toHaveProperty("agent-discovery");
      expect(sets).toHaveProperty("skill-management");
      expect(sets).toHaveProperty("agent-management");
      expect(sets).toHaveProperty("notifications");
    });
  });

  describe("getToolSet", () => {
    it("returns a tool set by id", () => {
      const set = getToolSet("math-conversions");
      expect(set).toBeDefined();
      expect(set.name).toBe("Math Conversions");
      expect(set.category).toBe("Math");
    });

    it("throws for an unregistered id", () => {
      expect(() => getToolSet("nonexistent")).toThrow(
        "Tool set with id 'nonexistent' has not been registered.",
      );
    });
  });

  describe("registerToolSet", () => {
    it("throws when registering a duplicate id", () => {
      expect(() =>
        registerToolSet("math-conversions", {
          name: "Duplicate",
          category: "Test",
          tools: {},
        }),
      ).toThrow(
        "Tool set with id 'math-conversions' has already been registered.",
      );
    });
  });

  describe("tool set metadata", () => {
    it("math-conversions has static tools object", () => {
      const set = getToolSet("math-conversions");
      expect(typeof set.tools).toBe("object");
      expect(set.tools).toHaveProperty("convertTemperature");
      expect(set.tools).toHaveProperty("convertDistance");
      expect(set.tools).toHaveProperty("convertWeight");
      expect(set.tools).toHaveProperty("convertVolume");
    });

    it("time has static tools object", () => {
      const set = getToolSet("time");
      expect(typeof set.tools).toBe("object");
      expect(set.tools).toHaveProperty("getCurrentTime");
      expect(set.tools).toHaveProperty("convertTimezone");
    });

    it("web-fetch has static tools object", () => {
      const set = getToolSet("web-fetch");
      expect(typeof set.tools).toBe("object");
      expect(set.tools).toHaveProperty("fetchUrl");
    });

    it("kanban has a factory function for tools", () => {
      const set = getToolSet("kanban");
      expect(typeof set.tools).toBe("function");
    });

    it("triggers has a factory function for tools", () => {
      const set = getToolSet("triggers");
      expect(typeof set.tools).toBe("function");
    });

    it("agent-discovery has a factory function for tools", () => {
      const set = getToolSet("agent-discovery");
      expect(typeof set.tools).toBe("function");
    });

    it("skill-management has a factory function for tools", () => {
      const set = getToolSet("skill-management");
      expect(typeof set.tools).toBe("function");
    });

    it("agent-management has a factory function for tools", () => {
      const set = getToolSet("agent-management");
      expect(typeof set.tools).toBe("function");
    });
  });

  describe("agent-management split toolsets contain expected tools", () => {
    const ctx = {
      workspaceId: "ws-1",
      agentId: "a-1",
      orgId: "org-1",
      frontendUrl: "http://localhost:3000",
      userId: "u-1",
    };

    it("agent-discovery exposes read-only agent and catalogue tools", () => {
      const set = getToolSet("agent-discovery");
      const tools =
        typeof set.tools === "function" ? set.tools(ctx) : set.tools;
      expect(Object.keys(tools).sort()).toEqual(
        ["getAgent", "listAgents", "listModelProviders", "listToolSets"].sort(),
      );
    });

    it("skill-management exposes the skill CRUD tools", () => {
      const set = getToolSet("skill-management");
      const tools =
        typeof set.tools === "function" ? set.tools(ctx) : set.tools;
      expect(Object.keys(tools).sort()).toEqual(
        ["deleteSkill", "getSkill", "listSkills", "upsertSkill"].sort(),
      );
    });

    it("agent-management exposes only write-side agent tools", () => {
      const set = getToolSet("agent-management");
      const tools =
        typeof set.tools === "function" ? set.tools(ctx) : set.tools;
      expect(Object.keys(tools).sort()).toEqual(
        ["createAgent", "deleteAgent", "updateAgent"].sort(),
      );
    });

    it("notifications has a factory function for tools", () => {
      const set = getToolSet("notifications");
      expect(typeof set.tools).toBe("function");
    });
  });
});
