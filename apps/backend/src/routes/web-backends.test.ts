import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadedPluginsFixture,
  mockDb,
  mockNoSession,
  mockSession,
  resetMockDb,
} from "../test-utils.ts";
import type { LoadedPlugin } from "../plugins/loader.ts";

const LOADED: LoadedPlugin[] = [
  {
    name: "acme-search",
    version: "2.3.1",
    origin: "third-party",
    toolSetIds: [],
    sandboxBackendIds: [],
    webBackendIds: ["acme-search.searx"],
    toolGateIds: [],
    config: undefined,
  },
];

const LOADED_RESULT = loadedPluginsFixture(LOADED, {
  webBackends: new Map([["acme-search.searx", "acme-search"]]),
});

const baseUrl = "/organizations/org-1/web-backends";

// why: each case needs a server whose Web backend registry was never touched
const loadServer = async () => {
  vi.resetModules();
  const [{ default: app }, backends, plugins] = await Promise.all([
    import("../server.ts"),
    import("../web-backends/index.ts"),
    import("../plugins/registry.ts"),
  ]);
  return { app, registerWebBackend: backends.registerWebBackend, plugins };
};

type Server = Awaited<ReturnType<typeof loadServer>>;

describe("Web backend catalog route", () => {
  let server: Server;

  beforeEach(async () => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    server = await loadServer();
    server.plugins.setLoadedPlugins(loadedPluginsFixture());
  });

  describe("GET /web-backends", () => {
    it("lists a registered backend annotated with the plugin that contributed it", async () => {
      server.plugins.setLoadedPlugins(LOADED_RESULT);
      server.registerWebBackend({
        backend: "acme-search.searx",
        name: "SearXNG",
        buildTurnTools: () => Promise.resolve({}),
      });
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await server.app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        results: [
          {
            backend: "acme-search.searx",
            name: "SearXNG",
            plugin: "acme-search",
          },
        ],
      });
    });

    it("annotates a backend belonging to no loaded plugin as null", async () => {
      server.registerWebBackend({
        backend: "orphan",
        name: "Orphan",
        buildTurnTools: () => Promise.resolve({}),
      });
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await server.app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        results: [{ backend: "orphan", name: "Orphan", plugin: null }],
      });
    });

    it("returns an empty list when no backend is registered", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await server.app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [] });
    });

    it("is readable by a non-admin org member", async () => {
      server.registerWebBackend({
        backend: "searx",
        name: "SearXNG",
        buildTurnTools: () => Promise.resolve({}),
      });
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await server.app.request(baseUrl);
      expect(res.status).toBe(200);
    });

    it("requires authentication", async () => {
      mockNoSession();
      const res = await server.app.request(baseUrl);
      expect(res.status).toBe(401);
    });

    it("rejects a caller with no membership of the org", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await server.app.request(baseUrl);
      expect(res.status).toBe(403);
    });

    it("exposes no mutation", async () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const res = await server.app.request(baseUrl, { method });
        expect(res.status).toBe(404);
      }
    });
  });
});
