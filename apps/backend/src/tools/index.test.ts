import { describe, it, expect, vi } from "vitest";

// Mock the db used by transitive imports (the sandbox tool set, etc.)
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

import {
  getToolSets,
  getToolSet,
  registerToolSet,
  SANDBOX_TOOLSET_ID,
} from "./index.ts";

describe("Tool Set Registry", () => {
  describe("getToolSets", () => {
    it("returns the statically-registered tool sets", () => {
      const sets = getToolSets();
      expect(Object.keys(sets).length).toBeGreaterThan(0);
    });

    it("no longer statically registers the plugin-migrated tool sets", () => {
      // Every native Tool set now ships as a core plugin loaded via the plugin
      // loader (ADR-0013): `math-conversions`/`time` → @platypus/tools-basic,
      // `web-fetch` → @platypus/web-fetch, and the Platypus-domain sets →
      // @platypus/tools-platform. None register at import time here anymore.
      const sets = getToolSets();
      for (const id of [
        "math-conversions",
        "time",
        "web-fetch",
        "kanban",
        "dashboards",
        "triggers",
        "agent-discovery",
        "skill-management",
        "agent-management",
        "notifications",
        "memory",
      ]) {
        expect(sets).not.toHaveProperty(id);
      }
    });

    it("still statically registers the sandbox tool set (core sandbox infra)", () => {
      // The `sandbox` set is the consumer side of the Sandbox-backend extension
      // point (ADR-0002), not a native Tool set, so it stays a core-internal
      // static registration — the lone one left in tools/index.ts.
      expect(getToolSets()).toHaveProperty(SANDBOX_TOOLSET_ID);
    });
  });

  describe("getToolSet", () => {
    it("returns the sandbox tool set by id", () => {
      const set = getToolSet(SANDBOX_TOOLSET_ID);
      expect(set).toBeDefined();
      expect(set.name).toBe("Sandbox");
      expect(set.category).toBe("Sandbox");
      expect(typeof set.tools).toBe("function");
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
        registerToolSet(SANDBOX_TOOLSET_ID, {
          name: "Duplicate",
          category: "Test",
          tools: {},
        }),
      ).toThrow(
        `Tool set with id '${SANDBOX_TOOLSET_ID}' has already been registered.`,
      );
    });

    it("registers a new tool set and returns it with its id folded in", () => {
      const set = registerToolSet("test-only-set", {
        name: "Test Only",
        category: "Test",
        tools: {},
      });
      expect(set.id).toBe("test-only-set");
      expect(getToolSet("test-only-set")).toBe(set);
    });
  });
});
