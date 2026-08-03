import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mockDb,
  mockNoSession,
  mockSession,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";
import { setLoadedPlugins } from "../plugins/registry.ts";
import type { LoadedPlugin } from "../plugins/loader.ts";
import { clearWebBackends, registerWebBackend } from "../web-backends/index.ts";

const LOADED: LoadedPlugin[] = [
  {
    name: "acme-search",
    version: "2.3.1",
    origin: "third-party",
    toolSetIds: [],
    sandboxBackendIds: [],
    webBackendIds: ["acme-search.searx"],
  },
];

const baseUrl = "/organizations/org-1/web-backends";

describe("Web backend catalog route", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    clearWebBackends();
    setLoadedPlugins([]);
  });

  afterEach(() => {
    clearWebBackends();
    setLoadedPlugins([]);
  });

  describe("GET /web-backends", () => {
    it("lists a registered backend annotated with the plugin that contributed it", async () => {
      setLoadedPlugins(LOADED);
      registerWebBackend({
        backend: "acme-search.searx",
        name: "SearXNG",
        buildTurnTools: () => Promise.resolve({}),
      });
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess()

      const res = await app.request(baseUrl);
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
      registerWebBackend({
        backend: "orphan",
        name: "Orphan",
        buildTurnTools: () => Promise.resolve({}),
      });
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        results: [{ backend: "orphan", name: "Orphan", plugin: null }],
      });
    });

    it("returns an empty list when no backend is registered", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [] });
    });

    // The read posture is deliberately `requireOrgAccess()` and not
    // `requireOrgAccess(["admin"])`: a non-admin Workspace Owner may edit a
    // workspace-scoped Provider when `providerSelfManagement` is set, and would
    // otherwise see an empty dropdown with no explanation.
    it("is readable by a non-admin org member", async () => {
      registerWebBackend({
        backend: "searx",
        name: "SearXNG",
        buildTurnTools: () => Promise.resolve({}),
      });
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
    });

    it("requires authentication", async () => {
      mockNoSession();
      const res = await app.request(baseUrl);
      expect(res.status).toBe(401);
    });

    it("rejects a caller with no membership of the org", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([]); // no organizationMember row

      const res = await app.request(baseUrl);
      expect(res.status).toBe(403);
    });

    // The catalog is deployment-wide and Operator-owned: backends arrive through
    // `PLATYPUS_PLUGINS`, never over the API, so there is no mutation to route.
    it("exposes no mutation", async () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const res = await app.request(baseUrl, { method });
        expect(res.status).toBe(404);
      }
    });
  });
});
