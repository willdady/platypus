import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockDb, resetMockDb, seedDb, type Row } from "../test-utils.ts";
import { mockLogger, mockNanoid } from "../test-setup.ts";

vi.mock("../services/trigger-firing.ts", () => ({
  fireTrigger: vi.fn(() => Promise.resolve("ran")),
}));
vi.mock("../services/notification.ts", () => ({
  createNotification: vi.fn(() => Promise.resolve({ id: "notification-1" })),
}));

import app from "../server.ts";
import { fireTrigger } from "../services/trigger-firing.ts";
import {
  hashBearerToken,
  resetTokenTouches,
} from "../services/bearer-token.ts";
import { resetInboundRunSlots } from "../services/inbound-trigger.ts";

const TOKEN = "pit_the-right-token";
const DAY = 24 * 60 * 60 * 1000;

const inbound = (over: Row = {}): Row => ({
  id: "trig-1",
  workspaceId: "ws-1",
  agentId: "agent-1",
  type: "inbound",
  name: "Ready for AI",
  instruction: "Work the issue",
  enabled: true,
  maxRunsToKeep: 10,
  config: {
    inputs: [{ name: "issueKey", required: true }],
    recordKey: "issueKey",
    tokenExpiryDays: 90,
  },
  tokenHash: hashBearerToken(TOKEN),
  tokenCreatedAt: new Date(Date.now() - DAY),
  tokenExpiresAt: new Date(Date.now() + 89 * DAY),
  tokenNotice: null,
  lastUsedAt: null,
  lastRejectedAt: null,
  createdAt: new Date(Date.now() - DAY),
  ...over,
});

const seed = ({
  triggers = [inbound()],
  gate = "all",
  runs = [],
  owner = {},
}: { triggers?: Row[]; gate?: string; runs?: Row[]; owner?: Row } = {}) =>
  seedDb({
    trigger: triggers,
    workspace: [
      {
        id: "ws-1",
        organizationId: "org-1",
        ownerId: "user-1",
        name: "Support",
        inboundTriggersAllowed: false,
      },
    ],
    organization: [{ id: "org-1", name: "Acme", inboundTriggerGate: gate }],
    user: [{ id: "user-1", name: "Owner", role: "user", ...owner }],
    organization_member: [
      { id: "member-1", organizationId: "org-1", userId: "user-1" },
    ],
    trigger_run: runs,
  });

type FireOptions = {
  token?: string | null;
  body?: string;
  query?: string;
};

const fire = (
  triggerId: string,
  {
    token = TOKEN,
    body = JSON.stringify({ inputs: { issueKey: "PLAT-42" } }),
    query = "",
  }: FireOptions = {},
) =>
  app.request(`/hooks/triggers/${triggerId}${query}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });

/** The call-log lines written so far, as their field objects. */
const callLogLines = () =>
  mockLogger.info.mock.calls
    .filter(([, message]) => message === "Inbound trigger call")
    .map(([fields]) => fields as Record<string, unknown>);

describe("/hooks/triggers", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    resetInboundRunSlots();
    resetTokenTouches();
  });

  afterEach(() => {
    delete process.env.INBOUND_TRIGGER_MAX_BODY_BYTES;
    delete process.env.INBOUND_TRIGGER_MAX_CONCURRENT_RUNS;
  });

  describe("POST /:triggerId", () => {
    it("accepts a call with 202 and a run id that already exists as pending", async () => {
      mockNanoid.mockReturnValueOnce("run-1");
      const fake = seed();

      const res = await fire("trig-1");

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ runId: "run-1", deduplicated: false });
      expect(fake.tables.trigger_run).toEqual([
        expect.objectContaining({ id: "run-1", status: "pending" }),
      ]);
      expect(fireTrigger).toHaveBeenCalledTimes(1);
      expect(fake.tables.trigger[0].lastUsedAt).toBeInstanceOf(Date);
      expect(callLogLines()).toEqual([
        {
          organizationId: "org-1",
          workspaceId: "ws-1",
          triggerId: "trig-1",
          outcome: "accepted",
          reason: null,
          runId: "run-1",
          deduplicated: false,
          recordKey: "PLAT-42",
        },
      ]);
    });

    it("returns the active run for the same record, marked deduplicated", async () => {
      seed({
        runs: [
          {
            id: "run-active",
            triggerId: "trig-1",
            entityId: "PLAT-42",
            status: "pending",
            startedAt: new Date(),
          },
        ],
      });

      const res = await fire("trig-1");

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        runId: "run-active",
        deduplicated: true,
      });
      expect(fireTrigger).not.toHaveBeenCalled();
      expect(callLogLines()).toEqual([
        expect.objectContaining({
          outcome: "deduplicated",
          deduplicated: true,
          runId: "run-active",
        }),
      ]);
    });

    it("answers every refusal that could reveal what exists with the same 404", async () => {
      const cases: Array<
        [string, () => Response | Promise<Response>, string, Row?]
      > = [];
      const expired = inbound({
        id: "trig-expired",
        tokenExpiresAt: new Date(Date.now() - 1),
      });
      const disabled = inbound({ id: "trig-disabled", enabled: false });
      const cron = inbound({ id: "trig-cron", type: "cron", tokenHash: null });

      cases.push(["unknown_trigger", () => fire("trig-nope"), "all"]);
      cases.push([
        "bad_token",
        () => fire("trig-1", { token: "pit_wrong" }),
        "all",
      ]);
      cases.push([
        "missing_token",
        () => fire("trig-1", { token: null }),
        "all",
      ]);
      cases.push([
        "missing_token",
        () => fire("trig-1", { token: null, query: `?token=${TOKEN}` }),
        "all",
      ]);
      cases.push(["expired_token", () => fire("trig-expired"), "all"]);
      cases.push(["disabled", () => fire("trig-disabled"), "all"]);
      cases.push(["not_inbound", () => fire("trig-cron"), "all"]);
      cases.push(["gate", () => fire("trig-1"), "off"]);
      cases.push(["owner_left", () => fire("trig-1"), "all", { banned: true }]);

      const responses: Array<{
        status: number;
        body: string;
        type: string | null;
      }> = [];
      for (const [reason, call, gate, owner] of cases) {
        vi.clearAllMocks();
        const fake = seed({
          triggers: [inbound(), expired, disabled, cron],
          gate,
          owner,
        });
        const res = await call();
        responses.push({
          status: res.status,
          body: await res.text(),
          type: res.headers.get("content-type"),
        });
        expect(callLogLines(), reason).toEqual([
          expect.objectContaining({ outcome: "rejected", reason }),
        ]);
        expect(fake.tables.trigger_run, reason).toEqual([]);
      }

      expect(new Set(responses.map((r) => JSON.stringify(r))).size).toBe(1);
      expect(responses[0]).toEqual({
        status: 404,
        body: JSON.stringify({ error: "Not Found" }),
        type: "application/json",
      });
    });

    it.each([
      ["a wrong token", "pit_wrong", {}],
      ["no token", null, {}],
      ["an expired token", TOKEN, { tokenExpiresAt: new Date(Date.now() - 1) }],
    ])(
      "stamps last rejected on a real Inbound Trigger called with %s",
      async (_case, token, over) => {
        const fake = seed({ triggers: [inbound(over)] });
        await fire("trig-1", { token });
        // The stamp is not awaited by the route; let it land.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(fake.tables.trigger[0].lastRejectedAt).toBeInstanceOf(Date);
        expect(fake.tables.trigger[0].lastUsedAt).toBeNull();
      },
    );

    it("refuses a body over the cap with 413 before looking at the token", async () => {
      process.env.INBOUND_TRIGGER_MAX_BODY_BYTES = "64";
      const fake = seed();

      const res = await fire("trig-1", {
        token: null,
        body: JSON.stringify({ inputs: { issueKey: "x".repeat(100) } }),
      });

      expect(res.status).toBe(413);
      expect(fake.tables.trigger_run).toEqual([]);
      expect(callLogLines()).toEqual([
        expect.objectContaining({
          outcome: "rejected",
          reason: "body_too_large",
          triggerId: "trig-1",
        }),
      ]);
    });

    it("never stamps last rejected on a 413, whatever token the call carries", async () => {
      process.env.INBOUND_TRIGGER_MAX_BODY_BYTES = "64";
      const earlier = new Date(Date.now() - DAY);

      for (const token of [null, "pit_wrong"]) {
        const fake = seed({ triggers: [inbound({ lastRejectedAt: earlier })] });

        const res = await fire("trig-1", {
          token,
          body: JSON.stringify({ inputs: { issueKey: "x".repeat(100) } }),
        });
        // The stamp is not awaited by the route; let one land if it was sent.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(res.status, String(token)).toBe(413);
        expect(fake.tables.trigger[0].lastRejectedAt, String(token)).toBe(
          earlier,
        );
        expect(fake.tables.trigger[0].lastUsedAt, String(token)).toBeNull();
      }
    });

    it("still writes the 413's log line when the Trigger lookup fails", async () => {
      process.env.INBOUND_TRIGGER_MAX_BODY_BYTES = "64";
      mockDb.limit.mockImplementationOnce(() => {
        throw new Error("database unreachable");
      });

      const res = await fire("trig-1", {
        body: JSON.stringify({ inputs: { issueKey: "x".repeat(100) } }),
      });

      expect(res.status).toBe(413);
      expect(callLogLines()).toEqual([
        expect.objectContaining({
          outcome: "rejected",
          reason: "body_too_large",
          triggerId: "trig-1",
          organizationId: null,
        }),
      ]);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: "database unreachable" }),
        "Failed to look up the inbound trigger an oversized call named",
      );
    });

    it("does not count a suppressed call as use", async () => {
      process.env.TRIGGER_BREAKER_MAX_RUNS = "1";
      try {
        const fake = seed({
          runs: [
            {
              id: "run-done",
              triggerId: "trig-1",
              entityId: "PLAT-42",
              status: "success",
              startedAt: new Date(Date.now() - 60_000),
            },
          ],
        });
        mockNanoid.mockReturnValueOnce("run-suppressed");

        const res = await fire("trig-1");

        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({
          runId: "run-suppressed",
          deduplicated: false,
        });
        expect(fake.tables.trigger[0].lastUsedAt).toBeNull();
        expect(callLogLines().at(-1)).toMatchObject({ outcome: "suppressed" });
      } finally {
        delete process.env.TRIGGER_BREAKER_MAX_RUNS;
      }
    });

    it("returns a record's active run with 202 even at the concurrency cap", async () => {
      process.env.INBOUND_TRIGGER_MAX_CONCURRENT_RUNS = "1";
      vi.mocked(fireTrigger).mockImplementationOnce(
        () => new Promise(() => {}),
      );
      mockNanoid.mockReturnValueOnce("run-1");
      seed();

      expect((await fire("trig-1")).status).toBe(202);
      const res = await fire("trig-1");

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ runId: "run-1", deduplicated: true });
    });

    it.each([
      ["not JSON", "{inputs:", "The request body is not valid JSON."],
      [
        "missing a required input",
        JSON.stringify({ inputs: {} }),
        "Required input 'issueKey' is missing.",
      ],
      [
        "with an undeclared input",
        JSON.stringify({ inputs: { issueKey: "A", x: "y" } }),
        "Input 'x' is not declared.",
      ],
      [
        "with a non-string value",
        JSON.stringify({ inputs: { issueKey: 42 } }),
        "Input 'issueKey' must be a string.",
      ],
    ])(
      "refuses a body %s with 400 naming the problem",
      async (_label, body, error) => {
        const fake = seed();

        const res = await fire("trig-1", { body });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error });
        expect(fake.tables.trigger_run).toEqual([]);
        expect(callLogLines()).toEqual([
          expect.objectContaining({
            outcome: "rejected",
            reason: "invalid_inputs",
          }),
        ]);
      },
    );

    it("answers 429 with Retry-After past the concurrency cap, writing no row", async () => {
      process.env.INBOUND_TRIGGER_MAX_CONCURRENT_RUNS = "1";
      vi.mocked(fireTrigger).mockImplementationOnce(
        () => new Promise(() => {}),
      );
      mockNanoid.mockReturnValueOnce("run-1");
      const fake = seed();

      expect((await fire("trig-1")).status).toBe(202);
      const res = await fire("trig-1", {
        body: JSON.stringify({ inputs: { issueKey: "PLAT-7" } }),
      });

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("30");
      expect(fake.tables.trigger_run).toHaveLength(1);
      expect(callLogLines().at(-1)).toMatchObject({
        outcome: "rate_limited",
        recordKey: "PLAT-7",
      });
      // The token was good: a full cap says nothing about it.
      expect(fake.tables.trigger[0].lastRejectedAt).toBeNull();
    });
  });

  describe("GET /:triggerId/runs/:runId", () => {
    const run = (over: Row = {}): Row => ({
      id: "run-1",
      triggerId: "trig-1",
      status: "failed",
      startedAt: new Date("2026-09-29T10:00:00.000Z"),
      completedAt: new Date("2026-09-29T10:05:00.000Z"),
      errorMessage: "Model error",
      finalText: "private output",
      eventData: { inputs: { issueKey: "PLAT-42" } },
      ...over,
    });

    const poll = (triggerId: string, runId: string, token = TOKEN) =>
      app.request(`/hooks/triggers/${triggerId}/runs/${runId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

    it("returns the run's status, timestamps and error, never its output", async () => {
      seed({ runs: [run()] });

      const res = await poll("trig-1", "run-1");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        runId: "run-1",
        status: "failed",
        startedAt: "2026-09-29T10:00:00.000Z",
        completedAt: "2026-09-29T10:05:00.000Z",
        errorMessage: "Model error",
      });
    });

    it("is 404 for another Trigger's run, a pruned run and a bad token", async () => {
      seed({
        triggers: [inbound(), inbound({ id: "trig-2" })],
        runs: [run({ id: "run-2", triggerId: "trig-2" })],
      });

      expect((await poll("trig-1", "run-2")).status).toBe(404);
      expect((await poll("trig-1", "run-gone")).status).toBe(404);
      expect((await poll("trig-2", "run-2", "pit_wrong")).status).toBe(404);
      expect((await poll("trig-2", "run-2")).status).toBe(200);
    });

    it("is 404 once the Workspace Owner is banned", async () => {
      seed({ runs: [run()], owner: { banned: true } });

      const res = await poll("trig-1", "run-1");

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not Found" });
    });
  });
});
