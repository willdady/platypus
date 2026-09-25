import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cardEvent,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
} from "../test-utils.ts";
import type { WorkspaceScope } from "../scope.ts";
import type { RunInput, RunSink } from "../runs/types.ts";

/**
 * Firing goes through its interface: the Agent run is the only seam mocked,
 * and everything else — the breaker, the sink's run row, the bookkeeping and
 * retention — runs against a seeded fake that reads the queries' predicates.
 */

/** Shape of the argument object passed to agentRunner.generate in these tests. */
type GenerateArgs = { scope: WorkspaceScope; input: RunInput; sink: RunSink };

const { mockGenerate } = vi.hoisted(() => ({ mockGenerate: vi.fn() }));

vi.mock("../runs/agent-runner.ts", () => ({
  agentRunner: { generate: mockGenerate },
}));

import { mockLogger, mockNanoid } from "../test-setup.ts";

import { fireTrigger } from "./trigger-firing.ts";
import type { TriggerRow } from "./trigger.ts";
import {
  currentCausingAgents,
  currentOriginatingTrigger,
  withCausation,
  withOriginatingTrigger,
} from "../event-causation.ts";

const NOW = new Date("2026-08-30T12:30:00.000Z");
const COMPLETED = new Date("2026-08-30T12:41:00.000Z");
/** Outside the default one-hour breaker window, so retention may prune it. */
const LONG_AGO = (minutes: number) =>
  new Date(Date.UTC(2026, 7, 28, 0, minutes));

const cronConfig = {
  cronExpression: "0 * * * *",
  timezone: "UTC",
  isOneOff: false,
};

const makeTrigger = (over: Partial<TriggerRow> = {}): TriggerRow => ({
  id: "trigger-1",
  workspaceId: "ws-1",
  agentId: "agent-1",
  type: "cron",
  name: "Test Trigger",
  description: null,
  instruction: "Do something",
  enabled: true,
  maxRunsToKeep: 10,
  search: false,
  includeMemories: false,
  config: cronConfig,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: LONG_AGO(0),
  updatedAt: LONG_AGO(0),
  ...over,
});

const eventTrigger = (over: Partial<TriggerRow> = {}) =>
  makeTrigger({
    type: "event",
    config: { events: ["card.created", "card.updated"] },
    ...over,
  });

const oldRun = (id: string, minutes: number, over: Row = {}): Row => ({
  id,
  triggerId: "trigger-1",
  status: "failed",
  entityId: null,
  startedAt: LONG_AGO(minutes),
  createdAt: LONG_AGO(minutes),
  ...over,
});

/**
 * Seeds the world a firing reads: the Workspace and its owner, and the
 * Trigger row as it is *now* — which a test may make differ from the snapshot
 * it fires.
 */
const world = (
  current: TriggerRow | null,
  runs: Row[] = [],
  { workspace = true }: { workspace?: boolean } = {},
): FakeDb =>
  seedDb({
    workspace: workspace
      ? [{ id: "ws-1", organizationId: "org-1", ownerId: "user-1" }]
      : [],
    user: [{ id: "user-1", name: "Ada Lovelace" }],
    trigger: current ? [current] : [],
    trigger_run: runs,
  });

/**
 * Stands in for the Drive: opens the run row through the sink, then ends it
 * with `status` — and, like `driveOnce`, rethrows when the run failed by
 * throwing. Time moves to COMPLETED while it runs.
 */
const drive = (status: "succeeded" | "failed", error?: Error) => {
  mockGenerate.mockImplementationOnce(async ({ input, sink }: GenerateArgs) => {
    await sink.onStart({ runId: input.runId, messages: input.messages });
    vi.setSystemTime(COMPLETED);
    await sink.onFinish({
      runId: input.runId,
      status,
      messages: input.messages,
      stats: {},
      error,
    });
    if (error) throw error;
    return { text: "ok", stats: {} };
  });
};

const generateArgs = () => mockGenerate.mock.calls[0][0] as GenerateArgs;

const instructionText = () => {
  const part = generateArgs().input.messages[0].parts[0];
  if (part.type !== "text") throw new Error("expected a text part");
  return part.text;
};

/** The run-start line the logger recorded, if any. */
const startLine = (): Record<string, unknown> | undefined =>
  mockLogger.info.mock.calls.find(
    (call) => call[1] === "Starting trigger execution",
  )?.[0] as Record<string, unknown> | undefined;

const triggerRow = (fake: FakeDb) => fake.tables.trigger[0];
const runIds = (fake: FakeDb) => fake.tables.trigger_run.map((r) => r.id);

describe("fireTrigger", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    process.env.FRONTEND_URL = "http://localhost:3000";
    mockNanoid.mockReturnValue("run-new");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("bookkeeping on every exit", () => {
    const threeOldRuns = [
      oldRun("old-1", 1),
      oldRun("old-2", 2),
      oldRun("old-3", 3),
    ];

    it.each([
      ["succeeds", "ran", () => drive("succeeded")],
      ["fails", "failed", () => drive("failed", new Error("Model error"))],
    ] as const)(
      "a recurring cron run that %s stamps completion, advances the schedule and trims history",
      async (_, outcome, arrange) => {
        const trigger = makeTrigger({ maxRunsToKeep: 2 });
        const fake = world(trigger, threeOldRuns);
        arrange();

        await expect(fireTrigger(trigger, { kind: "cron" })).resolves.toBe(
          outcome,
        );

        expect(triggerRow(fake)).toMatchObject({
          lastRunAt: COMPLETED,
          // "0 * * * *" from 12:41 is 13:00.
          nextRunAt: new Date("2026-08-30T13:00:00.000Z"),
          enabled: true,
        });
        // The newest two: this run and the newest of the old ones.
        expect(runIds(fake).sort()).toEqual(["old-3", "run-new"]);
      },
    );

    it.each([
      ["succeeds", () => drive("succeeded")],
      ["fails", () => drive("failed", new Error("Model error"))],
    ] as const)(
      "a one-off cron run that %s disables itself",
      async (_, arrange) => {
        const trigger = makeTrigger({
          config: { ...cronConfig, isOneOff: true },
        });
        const fake = world(trigger);
        arrange();

        await fireTrigger(trigger, { kind: "cron" });

        expect(triggerRow(fake)).toMatchObject({
          lastRunAt: COMPLETED,
          enabled: false,
          nextRunAt: null,
        });
      },
    );

    it.each([
      ["succeeds", "ran", () => drive("succeeded")],
      ["fails", "failed", () => drive("failed", new Error("Model error"))],
    ] as const)(
      "an event run that %s stamps completion and trims history, leaving the schedule alone",
      async (_, outcome, arrange) => {
        const trigger = eventTrigger({ maxRunsToKeep: 2 });
        const fake = world(trigger, threeOldRuns);
        arrange();

        await expect(
          fireTrigger(trigger, {
            kind: "event",
            payload: cardEvent("card.created", { id: "c1" }),
          }),
        ).resolves.toBe(outcome);

        expect(triggerRow(fake)).toMatchObject({
          lastRunAt: COMPLETED,
          nextRunAt: null,
          enabled: true,
        });
        expect(runIds(fake).sort()).toEqual(["old-3", "run-new"]);
      },
    );

    it("advances the schedule when the Workspace is missing, without invoking an Agent", async () => {
      const trigger = makeTrigger();
      const fake = world(trigger, [], { workspace: false });

      await expect(fireTrigger(trigger, { kind: "cron" })).resolves.toBe(
        "failed",
      );

      expect(mockGenerate).not.toHaveBeenCalled();
      expect(triggerRow(fake)).toMatchObject({
        lastRunAt: NOW,
        nextRunAt: new Date("2026-08-30T13:00:00.000Z"),
      });
    });

    it("logs a run failure rather than rejecting", async () => {
      const trigger = makeTrigger();
      world(trigger);
      mockGenerate.mockRejectedValueOnce(new Error("Model error"));

      await fireTrigger(trigger, { kind: "cron" });

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerId: "trigger-1",
          error: "Model error",
        }),
        "Trigger run failed",
      );
    });
  });

  describe("reads the row as it is once the run ends", () => {
    it.each([
      ["a recurring cron", makeTrigger()],
      ["an event", eventTrigger()],
    ])(
      "keeps %s Trigger disabled when its owner switched it off mid-run",
      async (_, snapshot) => {
        const fake = world({ ...snapshot, enabled: false });
        drive("succeeded");

        await fireTrigger(
          snapshot,
          snapshot.type === "event"
            ? { kind: "event", payload: cardEvent("card.created") }
            : { kind: "cron" },
        );

        expect(triggerRow(fake).enabled).toBe(false);
        expect(triggerRow(fake).lastRunAt).toEqual(COMPLETED);
      },
    );

    it("schedules from the config as edited mid-run, not the fired snapshot", async () => {
      const snapshot = makeTrigger();
      const fake = world({
        ...snapshot,
        config: { ...cronConfig, cronExpression: "*/15 * * * *" },
      });
      drive("succeeded");

      await fireTrigger(snapshot, { kind: "cron" });

      // Every fifteen minutes from 12:41 is 12:45 — the hourly snapshot would
      // have said 13:00.
      expect(triggerRow(fake).nextRunAt).toEqual(
        new Date("2026-08-30T12:45:00.000Z"),
      );
    });

    it("tolerates a Trigger deleted mid-run", async () => {
      const snapshot = makeTrigger();
      const fake = world(null);
      mockGenerate.mockResolvedValueOnce({ text: "ok", stats: {} });

      await expect(fireTrigger(snapshot, { kind: "cron" })).resolves.toBe(
        "ran",
      );

      expect(fake.tables.trigger).toEqual([]);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it("still stamps completion and trims history when the current row is malformed", async () => {
      const snapshot = makeTrigger({ maxRunsToKeep: 1 });
      const fake = world({ ...snapshot, config: { garbage: true } }, [
        oldRun("old-1", 1),
      ]);
      drive("succeeded");

      await expect(fireTrigger(snapshot, { kind: "cron" })).resolves.toBe(
        "ran",
      );

      expect(triggerRow(fake).lastRunAt).toEqual(COMPLETED);
      expect(runIds(fake)).toEqual(["run-new"]);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ triggerId: "trigger-1" }),
        "Trigger row is malformed; its schedule was not updated",
      );
    });

    it("leaves nextRunAt null and says so when the cron expression cannot be parsed", async () => {
      const snapshot = makeTrigger();
      const fake = world({
        ...snapshot,
        config: { ...cronConfig, cronExpression: "not a cron" },
      });
      drive("succeeded");

      await fireTrigger(snapshot, { kind: "cron" });

      expect(triggerRow(fake)).toMatchObject({
        lastRunAt: COMPLETED,
        nextRunAt: null,
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ cronExpression: "not a cron" }),
        "Failed to compute next run for trigger",
      );
    });
  });

  describe("the run-rate breaker", () => {
    /** Twenty recent runs for `entityId` — the default ceiling. */
    const recentRuns = (entityId: string) =>
      Array.from({ length: 20 }, (_, i) => ({
        id: `recent-${i}`,
        triggerId: "trigger-1",
        status: "success",
        entityId,
        startedAt: new Date(NOW.getTime() - (i + 1) * 60_000),
        createdAt: new Date(NOW.getTime() - (i + 1) * 60_000),
      }));

    it("drops a firing past the ceiling, recording a suppressed row instead of a run", async () => {
      const trigger = eventTrigger();
      const fake = world(trigger, recentRuns("c1"));
      const payload = cardEvent("card.updated", { id: "c1" });

      await expect(
        fireTrigger(trigger, { kind: "event", payload, entityId: "c1" }),
      ).resolves.toBe("suppressed");

      expect(mockGenerate).not.toHaveBeenCalled();
      expect(
        fake.tables.trigger_run.filter((r) => r.status === "suppressed"),
      ).toEqual([
        expect.objectContaining({
          entityId: "c1",
          eventType: "card.updated",
          eventData: payload.data,
        }),
      ]);
      // Not a run, so not a `lastRunAt`.
      expect(triggerRow(fake).lastRunAt).toBeNull();
    });

    it("drops the firing, and says so, when the breaker itself fails", async () => {
      const trigger = eventTrigger();
      const fake = world(trigger);
      vi.spyOn(
        fake.handle as { select: () => unknown },
        "select",
      ).mockImplementationOnce(() => {
        throw new Error("db down");
      });

      await expect(
        fireTrigger(trigger, {
          kind: "event",
          payload: cardEvent("card.updated", { id: "c1" }),
          entityId: "c1",
        }),
      ).resolves.toBe("failed");

      // Failing closed: no run, and no bookkeeping as if one happened.
      expect(mockGenerate).not.toHaveBeenCalled();
      expect(triggerRow(fake).lastRunAt).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        { triggerId: "trigger-1", error: "db down" },
        "Trigger run-rate breaker failed; firing dropped",
      );
    });

    it("bounds suppressed rows by their own budget", async () => {
      process.env.TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP = "2";
      try {
        const trigger = eventTrigger();
        const fake = world(trigger, [
          ...recentRuns("c1"),
          oldRun("sup-1", 1, { status: "suppressed", entityId: "c1" }),
          oldRun("sup-2", 2, { status: "suppressed", entityId: "c1" }),
        ]);

        await fireTrigger(trigger, {
          kind: "event",
          payload: cardEvent("card.updated", { id: "c1" }),
          entityId: "c1",
        });

        // The new suppressed row and the newest old one survive.
        expect(
          fake.tables.trigger_run
            .filter((r) => r.status === "suppressed")
            .map((r) => r.id)
            .sort(),
        ).toEqual(["run-new", "sup-2"]);
      } finally {
        delete process.env.TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP;
      }
    });

    it("counts per entity, so a busy Card does not hold back another", async () => {
      const trigger = eventTrigger();
      world(trigger, recentRuns("c1"));
      drive("succeeded");

      await expect(
        fireTrigger(trigger, {
          kind: "event",
          payload: cardEvent("card.updated", { id: "c2" }),
          entityId: "c2",
        }),
      ).resolves.toBe("ran");

      expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it("exempts a firing that names no single entity", async () => {
      const trigger = eventTrigger({
        config: { events: ["notification.read"] },
      });
      world(trigger, recentRuns("c1"));
      drive("succeeded");

      await fireTrigger(trigger, {
        kind: "event",
        payload: {
          event: "notification.read",
          data: { notificationIds: ["n-1"], userId: "user-1", bulk: true },
        },
      });

      expect(mockGenerate).toHaveBeenCalledTimes(1);
    });
  });

  describe("the run", () => {
    it("establishes itself as the originating Trigger for everything the run writes", async () => {
      const trigger = makeTrigger();
      world(trigger);
      let seen: { trigger?: string; agents?: readonly string[] } = {};
      mockGenerate.mockImplementationOnce(async () => {
        await Promise.resolve();
        seen = {
          trigger: currentOriginatingTrigger(),
          agents: currentCausingAgents(),
        };
        return { text: "ok", stats: {} };
      });

      await fireTrigger(trigger, { kind: "cron" });

      // The Agent chain is the Drive's to establish; this layer only names the
      // Trigger.
      expect(seen).toEqual({ trigger: "trigger-1", agents: [] });
    });

    it("runs the Agent as the Trigger, on behalf of the Workspace owner", async () => {
      const trigger = makeTrigger();
      world(trigger);
      drive("succeeded");

      await fireTrigger(trigger, { kind: "cron" });

      const { scope, input } = generateArgs();
      expect(scope.orgId).toBe("org-1");
      expect(scope.workspaceId).toBe("ws-1");
      const { principal } = scope;
      if (principal.kind !== "trigger")
        throw new Error("expected a trigger principal");
      expect(principal).toMatchObject({
        triggerId: "trigger-1",
        onBehalfOfUserId: "user-1",
        name: "Ada Lovelace",
      });
      expect(input.request.agentId).toBe("agent-1");
      expect(input.messages).toHaveLength(1);
      expect(instructionText()).toBe("Do something");
    });

    it("prepends the event to the instruction for an event Trigger", async () => {
      const trigger = eventTrigger();
      world(trigger);
      drive("succeeded");

      await fireTrigger(trigger, {
        kind: "event",
        payload: cardEvent("card.created", { id: "c1" }),
      });

      const text = instructionText();
      expect(text).toContain("Event: card.created");
      expect(text).toContain('"id": "c1"');
      expect(text).toContain("Do something");
    });

    it("records the event and its entity on the run row", async () => {
      const trigger = eventTrigger();
      const fake = world(trigger);
      drive("succeeded");
      const payload = cardEvent("card.created", { id: "c1" });

      await fireTrigger(trigger, { kind: "event", payload, entityId: "c1" });

      expect(fake.tables.trigger_run).toEqual([
        expect.objectContaining({
          id: "run-new",
          triggerId: "trigger-1",
          status: "success",
          entityId: "c1",
          eventType: "card.created",
          eventData: payload.data,
        }),
      ]);
    });

    it.each([false, true])(
      "forwards includeMemories: %s into the run input",
      async (includeMemories) => {
        const trigger = makeTrigger({ includeMemories });
        world(trigger);
        drive("succeeded");

        await fireTrigger(trigger, { kind: "cron" });

        expect(generateArgs().input.includeMemories).toBe(includeMemories);
      },
    );

    it("stamps the memories reference date at firing time", async () => {
      const trigger = makeTrigger();
      world(trigger);
      drive("succeeded");

      await fireTrigger(trigger, { kind: "cron" });

      expect(generateArgs().input.memoriesReferenceDate).toEqual(NOW);
    });

    it("propagates a search override from the trigger to the run input", async () => {
      const trigger = makeTrigger({ search: true });
      world(trigger);
      drive("succeeded");

      await fireTrigger(trigger, { kind: "cron" });

      expect(generateArgs().input.request.search).toBe(true);
    });

    it("runs under the Trigger timeouts", async () => {
      const trigger = makeTrigger();
      world(trigger);
      drive("succeeded");

      await fireTrigger(trigger, { kind: "cron" });

      const { options } = mockGenerate.mock.calls[0][0] as {
        options: { timeouts: unknown };
      };
      expect(options.timeouts).toEqual({
        perStepTimeoutMs: 10 * 60 * 1000,
        perRunTimeoutMs: 60 * 60 * 1000,
      });
    });

    it("records what caused this firing on the run-start line", async () => {
      const trigger = makeTrigger();
      world(trigger);
      drive("succeeded");

      await withOriginatingTrigger("trigger-0", () =>
        withCausation(["agent-9"], () =>
          fireTrigger(trigger, { kind: "cron" }),
        ),
      );

      expect(startLine()).toMatchObject({
        triggerId: "trigger-1",
        runId: "run-new",
        agentId: "agent-1",
        type: "cron",
        causingAgents: ["agent-9"],
        originatingTriggerId: "trigger-0",
      });
    });

    it("reports an uncaused firing as one, rather than omitting the fields", async () => {
      const trigger = makeTrigger();
      world(trigger);
      drive("succeeded");

      await fireTrigger(trigger, { kind: "cron" });

      expect(startLine()).toMatchObject({
        causingAgents: [],
        originatingTriggerId: undefined,
      });
    });

    it("logs identifiers only — never the event payload's user content", async () => {
      // The instruction an event Trigger runs opens with the serialised
      // payload, so a prefix of it is a prefix of the Card (#812).
      const trigger = eventTrigger();
      world(trigger);
      drive("succeeded");

      await fireTrigger(trigger, {
        kind: "event",
        payload: cardEvent("card.updated", {
          id: "c1",
          title: "Board the quarterly acquisition",
          body: "Confidential body text",
        }),
      });

      const logged = JSON.stringify([
        ...mockLogger.info.mock.calls,
        ...mockLogger.error.mock.calls,
      ]);
      expect(logged).not.toContain("Board the quarterly acquisition");
      expect(logged).not.toContain("Confidential body text");
      expect(logged).not.toContain("Do something");
      expect(startLine()).toMatchObject({ eventType: "card.updated" });
    });
  });
});
