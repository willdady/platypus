import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockNoSession,
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
  type Store,
} from "../test-utils.ts";

import app from "../server.ts";

const orgId = "org-1";
const workspaceId = "ws-1";
const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/trigger-runs`;

const triggerRow = (over: Row = {}): Row => ({
  id: "trig-1",
  workspaceId,
  agentId: "agent-1",
  type: "cron",
  name: "Nightly digest",
  description: null,
  instruction: "Do something",
  enabled: true,
  maxRunsToKeep: 10,
  search: false,
  includeMemories: false,
  extractMemories: false,
  config: { cronExpression: "0 9 * * *", timezone: "UTC", isOneOff: false },
  lastRunAt: null,
  nextRunAt: null,
  firedAt: null,
  tokenHash: null,
  tokenCreatedAt: null,
  tokenExpiresAt: null,
  tokenNotice: null,
  lastUsedAt: null,
  lastRejectedAt: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

const runRow = (over: Record<string, unknown> = {}) => ({
  id: "run-1",
  triggerId: "trig-1",
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

const world = (rows: Store = {}): FakeDb =>
  seedDb({
    organization_member: [
      {
        id: "member-1",
        organizationId: orgId,
        userId: "user-1",
        role: "member",
      },
    ],
    workspace: [
      {
        id: workspaceId,
        organizationId: orgId,
        ownerId: "user-1",
        name: "Support",
      },
    ],
    trigger: [triggerRow()],
    ...rows,
  });

describe("Trigger runs routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
  });

  describe("GET /", () => {
    it("lists runs from every trigger in the workspace, each naming its trigger", async () => {
      mockSession();
      world({
        trigger: [
          triggerRow({ name: "Nightly digest" }),
          triggerRow({ id: "trig-2", name: "Weekly" }),
          triggerRow({
            id: "trig-other",
            workspaceId: "ws-2",
            name: "Elsewhere",
          }),
        ],
        trigger_run: [
          runRow(),
          runRow({
            id: "run-2",
            triggerId: "trig-2",
            startedAt: new Date("2026-01-01T08:00:00Z"),
          }),
          runRow({ id: "run-other", triggerId: "trig-other" }),
        ],
      });

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

    it("scopes the query to triggers owned by this workspace", async () => {
      mockSession();
      world({
        trigger: [
          triggerRow({ id: "other-ws-trigger", workspaceId: "ws-2" }),
          triggerRow({ id: "own-trigger", name: "Mine" }),
        ],
        trigger_run: [
          runRow({ id: "run-out", triggerId: "other-ws-trigger" }),
          runRow({ id: "run-in", triggerId: "own-trigger" }),
        ],
      });

      const res = await app.request(`${baseUrl}?triggerId=other-ws-trigger`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { id: string }[] };
      expect(body.results).toEqual([]);
    });

    it("filters by status", async () => {
      mockSession();
      world({
        trigger: [triggerRow()],
        trigger_run: [
          runRow(),
          runRow({
            id: "run-2",
            status: "failed",
            startedAt: new Date("2026-01-01T08:00:00Z"),
          }),
        ],
      });

      const res = await app.request(`${baseUrl}?status=failed`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { id: string }[] };
      expect(body.results.map((r) => r.id)).toEqual(["run-2"]);
    });

    it("applies no trigger or status predicate when neither is given", async () => {
      mockSession();
      world({
        trigger: [triggerRow(), triggerRow({ id: "trig-2", name: "Weekly" })],
        trigger_run: [
          runRow(),
          runRow({
            id: "run-2",
            triggerId: "trig-2",
            status: "failed",
            startedAt: new Date("2026-01-01T08:00:00Z"),
          }),
        ],
      });

      const res = await app.request(baseUrl);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { id: string }[] };
      expect(body.results.map((r) => r.id)).toEqual(["run-1", "run-2"]);
    });

    it("defaults to the first 50 runs", async () => {
      mockSession();
      const newest = Date.parse("2026-01-01T10:00:00Z");
      world({
        trigger: [triggerRow()],
        trigger_run: Array.from({ length: 51 }, (_, i) =>
          runRow({
            id: `run-${i}`,
            startedAt: new Date(newest - i * 60_000),
          }),
        ),
      });

      const res = await app.request(baseUrl);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { id: string }[] };
      expect(body.results).toHaveLength(50);
      expect(body.results[0].id).toBe("run-0");
      expect(body.results.at(-1)!.id).toBe("run-49");
    });

    it("pages with limit and offset", async () => {
      mockSession();
      const newest = Date.parse("2026-01-01T10:00:00Z");
      world({
        trigger: [triggerRow()],
        trigger_run: Array.from({ length: 60 }, (_, i) =>
          runRow({
            id: `run-${i}`,
            startedAt: new Date(newest - i * 60_000),
          }),
        ),
      });

      const res = await app.request(`${baseUrl}?limit=25&offset=50`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { id: string }[] };
      expect(body.results).toHaveLength(10);
      expect(body.results[0].id).toBe("run-50");
      expect(body.results.at(-1)!.id).toBe("run-59");
    });

    it("requires a session", async () => {
      mockNoSession();

      const res = await app.request(baseUrl);

      expect(res.status).toBe(401);
    });
  });

  describe("GET / query validation", () => {
    const expectRejected = async (query: string) => {
      const [field] = query.split("=");
      mockSession();
      const fake = world();
      const res = await app.request(`${baseUrl}?${query}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: unknown };
      expect(Object.keys(body)).toEqual(["error"]);
      expect(body.error).toEqual([expect.objectContaining({ path: [field] })]);
      expect(fake.queries.filter((q) => q.table === "trigger_run")).toEqual([]);
    };

    it.each([
      ["an unrecognised status", "status=exploded"],
      ["an unparseable limit", "limit=lots"],
      ["a limit above the cap", "limit=101"],
      ["a limit below one", "limit=0"],
      ["a fractional limit", "limit=1.5"],
      ["a negative offset", "offset=-1"],
      ["an unparseable offset", "offset=later"],
    ])("rejects %s", async (_label, query) => {
      await expectRejected(query);
    });
  });
});

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
    mockSession();
    world({
      trigger: [triggerRow()],
      trigger_run: [
        runRow({ finalText: "Three cards moved.", eventsTruncated: false }),
      ],
      trigger_run_event: [
        eventRow({ id: "ev-2", seq: 1, type: "text", toolName: null }),
        eventRow(),
        eventRow({ id: "ev-other", runId: "run-2" }),
      ],
    });

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
  });

  it("scopes the run to this workspace and answers 404 for one it cannot reach", async () => {
    mockSession();
    const fake = world({
      trigger: [triggerRow({ id: "trig-elsewhere", workspaceId: "ws-2" })],
      trigger_run: [
        runRow({ id: "run-elsewhere", triggerId: "trig-elsewhere" }),
      ],
      trigger_run_event: [eventRow({ runId: "run-elsewhere" })],
    });

    const res = await app.request(`${baseUrl}/run-elsewhere`);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Trigger run not found");
    expect(fake.queries.some((q) => q.table === "trigger_run_event")).toBe(
      false,
    );
  });

  it("returns only events past `sinceSeq` when asked", async () => {
    mockSession();
    world({
      trigger: [triggerRow()],
      trigger_run: [runRow()],
      trigger_run_event: [
        eventRow({ id: "ev-1", seq: 0 }),
        eventRow({ id: "ev-2", seq: 1 }),
        eventRow({ id: "ev-3", seq: 2 }),
      ],
    });

    const res = await app.request(`${baseUrl}/run-1?sinceSeq=1`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { seq: number }[] };
    expect(body.events.map((e) => e.seq)).toEqual([2]);
  });

  it("rejects an unreadable `sinceSeq` rather than returning the whole timeline", async () => {
    mockSession();
    world({ trigger_run: [runRow()] });

    const res = await app.request(`${baseUrl}/run-1?sinceSeq=soon`);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: unknown };
    expect(body.error).toEqual([
      expect.objectContaining({ path: ["sinceSeq"] }),
    ]);
  });

  it("renders a run that predates timelines — no events, no final text", async () => {
    mockSession();
    world({
      trigger: [triggerRow()],
      trigger_run: [runRow({ finalText: null, eventsTruncated: false })],
    });

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

describe("GET / never selects Run events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
  });

  it("issues one query, against the run and trigger tables only", async () => {
    mockSession();
    const fake = world({
      trigger: [triggerRow()],
      trigger_run: [runRow({ finalText: "not on the list" })],
    });

    const res = await app.request(baseUrl);

    expect(res.status).toBe(200);
    expect(
      fake.queries.filter(
        (q) => q.kind === "select" && q.table === "trigger_run",
      ),
    ).toHaveLength(1);
    expect(fake.queries.some((q) => q.table === "trigger_run_event")).toBe(
      false,
    );
    const body = (await res.json()) as { results: Row[] };
    expect(body.results[0]).not.toHaveProperty("finalText");
  });
});

describe("unloaded Tool sets and failed tool calls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
  });

  const unloadedToolSets = [
    { toolSetId: "mcp-1", name: "Jira", reason: "unreachable" },
  ];

  it("selects both on the list row and returns them", async () => {
    mockSession();
    world({
      trigger: [triggerRow()],
      trigger_run: [runRow({ unloadedToolSets, failedToolCalls: 2 })],
    });

    const res = await app.request(baseUrl);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Record<string, unknown>[] };
    expect(body.results[0]).toMatchObject({
      unloadedToolSets,
      failedToolCalls: 2,
    });
  });

  it("selects both on the run detail", async () => {
    mockSession();
    world({
      trigger: [triggerRow()],
      trigger_run: [runRow({ unloadedToolSets, failedToolCalls: 3 })],
    });

    const res = await app.request(`${baseUrl}/run-1`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: Record<string, unknown> };
    expect(body.run).toMatchObject({
      unloadedToolSets,
      failedToolCalls: 3,
    });
  });
});
