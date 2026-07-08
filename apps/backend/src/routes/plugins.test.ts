import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockNoSession,
  mockSession,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";
import { setLoadedPlugins } from "../plugins/registry.ts";
import type { LoadedPlugin } from "../plugins/loader.ts";

const LOADED: LoadedPlugin[] = [
  {
    name: "@platypus/tools-basic",
    version: "1.0.0",
    origin: "core",
    toolSetIds: ["math-conversions", "time"],
    sandboxBackendIds: [],
  },
  {
    name: "acme-sandbox",
    version: "2.3.1",
    origin: "third-party",
    toolSetIds: ["acme-sandbox.management"],
    sandboxBackendIds: ["acme-sandbox.sandbox"],
  },
];

describe("Plugins Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    setLoadedPlugins(LOADED);
  });

  const baseUrl = "/organizations/org-1/plugins";

  describe("GET /plugins", () => {
    it("lets an Org Admin view loaded plugins with versions, origin, and contributions", async () => {
      // A regular platform user (not a super admin) who is an admin of the org.
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess(["admin"])

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{
          name: string;
          version: string;
          origin: string;
          contributions: { toolSets: string[]; sandboxBackends: string[] };
        }>;
      };

      expect(body.results).toEqual([
        {
          name: "@platypus/tools-basic",
          version: "1.0.0",
          origin: "core",
          contributions: {
            toolSets: ["math-conversions", "time"],
            sandboxBackends: [],
          },
        },
        {
          name: "acme-sandbox",
          version: "2.3.1",
          origin: "third-party",
          contributions: {
            toolSets: ["acme-sandbox.management"],
            sandboxBackends: ["acme-sandbox.sandbox"],
          },
        },
      ]);
    });

    it("requires authentication", async () => {
      mockNoSession();
      const res = await app.request(baseUrl);
      expect(res.status).toBe(401);
    });

    it("forbids a non-admin org member — the view is Org-Admin only", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess(["admin"])

      const res = await app.request(baseUrl);
      expect(res.status).toBe(403);
    });

    it("exposes no enable/disable mutation — writes are not routed", async () => {
      // The catalog is read-only (ADR-0013): there is no mutation endpoint, so
      // any write verb falls through to a 404 rather than toggling a plugin.
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const res = await app.request(baseUrl, { method });
        expect(res.status).toBe(404);
      }
    });
  });
});
