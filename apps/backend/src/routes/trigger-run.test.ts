import { describe, it, expect, beforeEach, vi } from "vitest";
// test-utils installs the drizzle-orm mock, so it must be imported before the
// operators this file asserts on — `eq` is a spy only through that mock.
import {
  mockDb,
  mockNoSession,
  mockSession,
  resetMockDb,
} from "../test-utils.ts";
import { eq } from "drizzle-orm";
import {
  trigger as triggerTable,
  triggerRun as triggerRunTable,
} from "../db/schema.ts";

import app from "../server.ts";

const orgId = "org-1";
const workspaceId = "ws-1";
const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/trigger-runs`;

/** Stub the two middleware DB lookups (requireOrgAccess + requireWorkspaceAccess). */
const stubAuthLookups = () => {
  mockSession();
  mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
  mockDb.limit.mockResolvedValueOnce([
    { ownerId: "user-1", organizationId: "org-1" },
  ]);
};

const runRow = (over: Record<string, unknown> = {}) => ({
  id: "run-1",
  triggerId: "trig-1",
  triggerName: "Nightly digest",
  status: "success",
  eventType: null,
  eventData: null,
  startedAt: new Date("2026-01-01T09:00:00Z"),
  completedAt: new Date("2026-01-01T09:00:10Z"),
  errorMessage: null,
  stats: null,
  createdAt: new Date("2026-01-01T09:00:00Z"),
  ...over,
});

describe("Trigger runs routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
  });

  describe("GET /", () => {
    it("lists runs from every trigger in the workspace, each naming its trigger", async () => {
      stubAuthLookups();
      mockDb.offset.mockResolvedValueOnce([
        runRow(),
        runRow({ id: "run-2", triggerId: "trig-2", triggerName: "Weekly" }),
      ]);

      const res = await app.request(baseUrl);

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: { id: string; triggerName: string }[];
      };
      expect(body.results.map((r) => [r.id, r.triggerName])).toEqual([
        ["run-1", "Nightly digest"],
        ["run-2", "Weekly"],
      ]);
    });

    // The join to the trigger table is what makes a run outside this Workspace
    // unreachable — including when its own trigger's id is handed in as
    // `triggerId`.
    it("scopes the query to triggers owned by this workspace", async () => {
      stubAuthLookups();
      mockDb.offset.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}?triggerId=other-ws-trigger`);

      expect(res.status).toBe(200);
      expect(mockDb.innerJoin).toHaveBeenCalled();
      expect(eq).toHaveBeenCalledWith(triggerTable.workspaceId, workspaceId);
      expect(eq).toHaveBeenCalledWith(
        triggerRunTable.triggerId,
        "other-ws-trigger",
      );
    });

    it("filters by status", async () => {
      stubAuthLookups();
      mockDb.offset.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}?status=failed`);

      expect(res.status).toBe(200);
      expect(eq).toHaveBeenCalledWith(triggerRunTable.status, "failed");
    });

    it("applies no trigger or status predicate when neither is given", async () => {
      stubAuthLookups();
      mockDb.offset.mockResolvedValueOnce([]);

      await app.request(baseUrl);

      expect(eq).not.toHaveBeenCalledWith(
        triggerRunTable.status,
        expect.anything(),
      );
      // The only predicate on `triggerId` is the join to its Trigger; nothing
      // narrows the list to one.
      expect(eq).toHaveBeenCalledWith(
        triggerRunTable.triggerId,
        triggerTable.id,
      );
      expect(
        vi
          .mocked(eq)
          .mock.calls.filter((call) => call[0] === triggerRunTable.triggerId),
      ).toHaveLength(1);
    });

    it("defaults to the first 50 runs", async () => {
      stubAuthLookups();
      mockDb.offset.mockResolvedValueOnce([]);

      await app.request(baseUrl);

      expect(mockDb.limit).toHaveBeenLastCalledWith(50);
      expect(mockDb.offset).toHaveBeenLastCalledWith(0);
    });

    it("pages with limit and offset", async () => {
      stubAuthLookups();
      mockDb.offset.mockResolvedValueOnce([]);

      await app.request(`${baseUrl}?limit=25&offset=50`);

      expect(mockDb.limit).toHaveBeenLastCalledWith(25);
      expect(mockDb.offset).toHaveBeenLastCalledWith(50);
    });

    it("requires a session", async () => {
      mockNoSession();

      const res = await app.request(baseUrl);

      expect(res.status).toBe(401);
    });
  });

  // A filter that is silently dropped, or a limit quietly coerced to a default,
  // renders a list that lies about what it is filtered to.
  describe("GET / query validation", () => {
    const expectRejected = async (query: string) => {
      stubAuthLookups();
      const res = await app.request(`${baseUrl}?${query}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeTruthy();
      expect(mockDb.offset).not.toHaveBeenCalled();
    };

    it("rejects an unrecognised status", async () => {
      await expectRejected("status=exploded");
    });

    it("rejects an unparseable limit", async () => {
      await expectRejected("limit=lots");
    });

    it("rejects a limit above the cap", async () => {
      await expectRejected("limit=101");
    });

    it("names the parameter it rejected", async () => {
      stubAuthLookups();

      const res = await app.request(`${baseUrl}?limit=101`);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("limit");
    });

    it("rejects a limit below one", async () => {
      await expectRejected("limit=0");
    });

    it("rejects a negative offset", async () => {
      await expectRejected("offset=-1");
    });

    it("rejects an unparseable offset", async () => {
      await expectRejected("offset=later");
    });
  });
});
