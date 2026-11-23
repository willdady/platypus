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

const CONFIGURED_BACKEND = "test-configured";
registerSandboxBackend({
  backend: CONFIGURED_BACKEND,
  name: "Test Configured",
  configSchema: z
    .object({
      region: z.string().min(1),
      replicas: z.number().int().default(1),
    })
    .strict(),
  credentialsSchema: z.object({ apiToken: z.string().min(1) }).strict(),
  create: () => {
    throw new Error("not used in this test");
  },
});

const UNREPRESENTABLE_BACKEND = "test-unrepresentable";
registerSandboxBackend({
  backend: UNREPRESENTABLE_BACKEND,
  name: "Test Unrepresentable",
  configSchema: z.object({ opaque: z.custom<unknown>(() => true) }),
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
    const asPlugin = (backendIds: string[]) => {
      setLoadedPlugins(
        loadedPluginsFixture(
          [
            {
              name: "@platypus/test",
              version: "1.0.0",
              origin: "core",
              toolSetIds: [],
              sandboxBackendIds: backendIds,
              webBackendIds: [],
              toolGateIds: [],
              config: undefined,
            },
          ],
          {
            sandboxBackends: new Map(
              backendIds.map((id) => [id, "@platypus/test"]),
            ),
          },
        ),
      );
    };

    it("returns registered backends with id, name, and originating plugin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      asPlugin([ANNOTATED_BACKEND]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{
          backend: string;
          name: string;
          plugin: string | null;
        }>;
      };
      for (const r of body.results) {
        if (r.backend !== ANNOTATED_BACKEND) continue;
        expect(Object.keys(r).sort()).toEqual(["backend", "name", "plugin"]);
      }
      expect(body.results).toContainEqual({
        backend: ANNOTATED_BACKEND,
        name: "Test Catalog",
        plugin: "@platypus/test",
      });
    });

    it("carries a backend's config and credentials schemas as JSON Schema", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      asPlugin([CONFIGURED_BACKEND]);

      const res = await app.request(baseUrl);
      const body = (await res.json()) as {
        results: Array<{
          backend: string;
          configSchema?: Record<string, unknown>;
          credentialsSchema?: Record<string, unknown>;
        }>;
      };
      const entry = body.results.find((r) => r.backend === CONFIGURED_BACKEND);

      expect(entry?.configSchema).toMatchObject({
        type: "object",
        properties: {
          region: { type: "string" },
          replicas: { type: "integer", default: 1 },
        },
        required: ["region"],
      });
      expect(entry?.credentialsSchema).toMatchObject({
        type: "object",
        properties: { apiToken: { type: "string" } },
        required: ["apiToken"],
      });
    });

    it("omits both schemas for a backend that declares no fields", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      asPlugin([ANNOTATED_BACKEND]);

      const res = await app.request(baseUrl);
      const body = (await res.json()) as {
        results: Array<Record<string, unknown>>;
      };
      const entry = body.results.find((r) => r.backend === ANNOTATED_BACKEND);

      expect(entry).not.toHaveProperty("configSchema");
      expect(entry).not.toHaveProperty("credentialsSchema");
    });

    it("still lists a backend whose schema has no JSON Schema form", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      asPlugin([UNREPRESENTABLE_BACKEND]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<Record<string, unknown>>;
      };
      const entry = body.results.find(
        (r) => r.backend === UNREPRESENTABLE_BACKEND,
      );

      expect(entry).toMatchObject({ name: "Test Unrepresentable" });
      expect(entry).not.toHaveProperty("configSchema");
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
