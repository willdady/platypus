import { describe, it, expect, beforeEach, vi } from "vitest";
// test-utils installs the drizzle-orm mock, so it must be imported before the
// operators this file asserts on — `eq` is a spy only through that mock.
import {
  mockDb,
  mockNoSession,
  mockSession,
  resetMockDb,
} from "../test-utils.ts";
import { eq, gt } from "drizzle-orm";
import {
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  triggerRunEvent as triggerRunEventTable,
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
      expect(body.error).toMatch(/^Invalid query parameters: /);
      expect(mockDb.offset).not.toHaveBeenCalled();
    };

    it.each([
      ["an unrecognised status", "status=exploded"],
      ["an unparseable limit", "limit=lots"],
      ["a limit above the cap", "limit=101"],
      ["a limit below one", "limit=0"],
      ["a negative offset", "offset=-1"],
      ["an unparseable offset", "offset=later"],
    ])("rejects %s", async (_label, query) => {
      await expectRejected(query);
    });

    it("names the parameter it rejected", async () => {
      stubAuthLookups();

      const res = await app.request(`${baseUrl}?limit=101`);

      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("limit");
    });
  });
});

/**
 * The run detail read (#647): the run in full plus its Run timeline. The list
 * above is pinned never to reach the events table; this is the read that does.
 */
describe("GET /:runId", () => {
  const eventRow = (over: Record<string, unknown> = {}) => ({
    id: "ev-1",
    runId: "run-1",
    parentEventId: null,
    seq: 0,
    type: "tool-call",
    toolName: "search",
    startedAt: 1_767_258_000_000,
    durationMs: 250,
    status: "completed",
    error: null,
    childrenTruncated: false,
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
  });

  it("returns the run with its final text and its events in sequence order", async () => {
    stubAuthLookups();
    mockDb.limit.mockResolvedValueOnce([
      runRow({ finalText: "Three cards moved.", eventsTruncated: false }),
    ]);
    mockDb.orderBy.mockResolvedValueOnce([
      eventRow(),
      eventRow({ id: "ev-2", seq: 1, type: "text", toolName: null }),
    ]);

    const res = await app.request(`${baseUrl}/run-1`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: { id: string; finalText: string; triggerName: string };
      events: { id: string; type: string }[];
    };
    expect(body.run.id).toBe("run-1");
    expect(body.run.finalText).toBe("Three cards moved.");
    expect(body.run.triggerName).toBe("Nightly digest");
    expect(body.events.map((e) => [e.id, e.type])).toEqual([
      ["ev-1", "tool-call"],
      ["ev-2", "text"],
    ]);
    // The events read is scoped to this run alone.
    expect(eq).toHaveBeenCalledWith(triggerRunEventTable.runId, "run-1");
  });

  it("scopes the run to this workspace and answers 404 for one it cannot reach", async () => {
    stubAuthLookups();
    mockDb.limit.mockResolvedValueOnce([]);

    const res = await app.request(`${baseUrl}/run-elsewhere`);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Trigger run not found");
    expect(eq).toHaveBeenCalledWith(triggerTable.workspaceId, workspaceId);
    expect(mockDb.orderBy).not.toHaveBeenCalled();
  });

  it("returns only events past `sinceSeq` when asked", async () => {
    stubAuthLookups();
    mockDb.limit.mockResolvedValueOnce([runRow()]);
    mockDb.orderBy.mockResolvedValueOnce([eventRow({ id: "ev-3", seq: 2 })]);

    const res = await app.request(`${baseUrl}/run-1?sinceSeq=1`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { seq: number }[] };
    expect(body.events.map((e) => e.seq)).toEqual([2]);
    expect(gt).toHaveBeenCalledWith(triggerRunEventTable.seq, 1);
  });

  it("rejects an unreadable `sinceSeq` rather than returning the whole timeline", async () => {
    stubAuthLookups();

    const res = await app.request(`${baseUrl}/run-1?sinceSeq=soon`);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/sinceSeq/);
  });

  it("renders a run that predates timelines — no events, no final text", async () => {
    stubAuthLookups();
    mockDb.limit.mockResolvedValueOnce([
      runRow({ finalText: null, eventsTruncated: false }),
    ]);
    mockDb.orderBy.mockResolvedValueOnce([]);

    const res = await app.request(`${baseUrl}/run-1`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: { finalText: null };
      events: unknown[];
    };
    expect(body.run.finalText).toBeNull();
    expect(body.events).toEqual([]);
  });

  it("requires authentication", async () => {
    mockNoSession();

    const res = await app.request(`${baseUrl}/run-1`);

    expect(res.status).toBe(401);
  });
});

// The list is polled every ten seconds by every open tab, and a timeline can
// hold thousands of rows — so the list read must never reach the events table
// or the per-run final text (#647). Pinned here because the query selects
// explicit columns, and the next person to add one will not know why.
describe("GET / never selects Run events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
  });

  it("issues one query, against the run and trigger tables only", async () => {
    stubAuthLookups();
    mockDb.offset.mockResolvedValueOnce([runRow()]);

    const res = await app.request(baseUrl);

    expect(res.status).toBe(200);
    // The auth middleware makes its own reads; the list's is the one that
    // projects the trigger's name onto the row.
    const listSelects = mockDb.select.mock.calls
      .map((call) => call[0] as Record<string, unknown> | undefined)
      .filter((cols) => cols !== undefined && "triggerName" in cols);
    expect(listSelects).toHaveLength(1);
    expect(listSelects[0]).not.toHaveProperty("finalText");
    for (const call of mockDb.from.mock.calls) {
      expect(call[0]).not.toBe(triggerRunEventTable);
    }
  });
});
