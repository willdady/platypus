import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import {
  loadedPluginsFixture,
  mockDb,
  mockSession,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";
import { registerSandboxBackend } from "../sandbox/index.ts";
import { setLoadedPlugins } from "../plugins/registry.ts";

// Register a backend directly (bypassing the loader) so the catalog has a
// stable entry to assert against.
const ANNOTATED_BACKEND = "test-catalog";
registerSandboxBackend({
  backend: ANNOTATED_BACKEND,
  name: "Test Catalog",
  configSchema: z.object({}),
  credentialsSchema: z.object({}),
  create: () => {
    throw new Error("not used in this test");
  },
});

const baseUrl = "/organizations/org-1/sandbox-backends";

describe("Sandbox backend catalog routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    setLoadedPlugins(loadedPluginsFixture());
  });

  describe("GET /", () => {
    it("returns registered backends with id, name, and originating plugin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess()
      // Attribute the pre-registered backend to a plugin (ADR-0013).
      setLoadedPlugins(
        loadedPluginsFixture(
          [
            {
              name: "@platypus/test",
              version: "1.0.0",
              origin: "core",
              toolSetIds: [],
              sandboxBackendIds: [ANNOTATED_BACKEND],
              webBackendIds: [],
            },
          ],
          { sandboxBackends: new Map([[ANNOTATED_BACKEND, "@platypus/test"]]) },
        ),
      );

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{
          backend: string;
          name: string;
          plugin: string | null;
        }>;
      };
      // Every entry carries backend/name/plugin — plugin is `null` when the id
      // belongs to no loaded plugin, and the contributing plugin's name when it
      // does.
      for (const r of body.results) {
        expect(Object.keys(r).sort()).toEqual(["backend", "name", "plugin"]);
      }
      expect(body.results).toContainEqual({
        backend: ANNOTATED_BACKEND,
        name: "Test Catalog",
        plugin: "@platypus/test",
      });
    });
  });

  describe("GET /networks", () => {
    it("returns 403 for a non-admin member", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request(`${baseUrl}/networks`);
      expect(res.status).toBe(403);
    });

    it("lists the allowed Docker networks for an admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);

      const res = await app.request(`${baseUrl}/networks`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: unknown };
      expect(Array.isArray(body.results)).toBe(true);
    });
  });
});
