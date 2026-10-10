import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockNanoid } from "../test-setup.ts";
import { resetMockDb, seedDb, type Row, type Store } from "../test-utils.ts";

vi.mock("../utils/cron.ts", () => ({
  validateCronExpression: vi.fn((expr: string) => {
    if (expr === "invalid") return null;
    return new Date("2026-01-01T10:00:00Z");
  }),
}));

mockNanoid.mockReturnValue("trig-new");

import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  listTriggers,
  regenerateTriggerToken,
  toPublicTrigger,
  updateTrigger,
  type TriggerCreateFields,
  type TriggerRow,
  type TriggerUpdateFields,
} from "./trigger.ts";
import { hashBearerToken } from "./bearer-token.ts";
import { NotFoundError, ValidationError } from "../errors.ts";

const ctx = { orgId: "org-1", workspaceId: "ws-1" };
const NEXT_RUN = new Date("2026-01-01T10:00:00Z");

const cronFields = (): TriggerCreateFields => ({
  agentId: "agent-1",
  type: "cron",
  name: "Daily",
  instruction: "Do something",
  enabled: true,
  maxRunsToKeep: 10,
  search: false,
  includeMemories: false,
  config: { cronExpression: "0 9 * * *", timezone: "UTC", isOneOff: false },
});

const eventFields = (): TriggerCreateFields => ({
  ...cronFields(),
  type: "event",
  name: "On Card",
  config: { events: ["card.created"] },
});

const inboundFields = (): TriggerCreateFields => ({
  ...cronFields(),
  type: "inbound",
  name: "Ready for AI",
  config: {
    inputs: [{ name: "issueKey", required: true, description: "Issue key" }],
    recordKey: "issueKey",
    tokenExpiryDays: 30,
  },
});

/** A stored Trigger row in `ws-1`, pointing at `agent-1`. */
const triggerRow = (overrides: Row = {}): Row => ({
  id: "trig-1",
  workspaceId: "ws-1",
  agentId: "agent-1",
  type: "cron",
  name: "Daily",
  enabled: true,
  config: { cronExpression: "0 9 * * *", timezone: "UTC" },
  nextRunAt: null,
  createdAt: new Date("2026-01-01"),
  ...overrides,
});

/**
 * `ws-1` in `org-1` holds `agent-1`; `org-1` shares `shared-attached` (attached
 * to `ws-1`) and `shared-unattached`; `ws-2` holds `agent-other`.
 */
const world = (rows: Store = {}) =>
  seedDb({
    agent: [
      { id: "agent-1", workspaceId: "ws-1", organizationId: null },
      { id: "agent-other", workspaceId: "ws-2", organizationId: null },
      { id: "shared-attached", workspaceId: null, organizationId: "org-1" },
      { id: "shared-unattached", workspaceId: null, organizationId: "org-1" },
    ],
    attachment: [
      {
        id: "att-1",
        workspaceId: "ws-1",
        resourceType: "agent",
        resourceId: "shared-attached",
      },
    ],
    ...rows,
  });

describe("trigger module", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  describe("createTrigger", () => {
    it("computes nextRunAt and inserts a cron trigger", async () => {
      const fake = world();

      const row = await createTrigger(ctx, cronFields());

      expect(row).toMatchObject({ id: "trig-new", workspaceId: "ws-1" });
      expect(fake.tables.trigger).toEqual([
        expect.objectContaining({ id: "trig-new", nextRunAt: NEXT_RUN }),
      ]);
    });

    it("accepts a Shared agent attached to this workspace", async () => {
      const fake = world();

      await createTrigger(ctx, { ...cronFields(), agentId: "shared-attached" });

      expect(fake.tables.trigger).toEqual([
        expect.objectContaining({ agentId: "shared-attached" }),
      ]);
    });

    it.each([
      ["a Shared agent not attached here", "shared-unattached"],
      ["another workspace's agent", "agent-other"],
      ["a missing agent", "agent-missing"],
    ])("rejects %s and writes nothing", async (_label, agentId) => {
      const fake = world();

      await expect(
        createTrigger(ctx, { ...cronFields(), agentId }),
      ).rejects.toThrow(
        new ValidationError("Agent not found in this workspace"),
      );
      expect(fake.tables.trigger ?? []).toHaveLength(0);
    });

    it("applies the defaults to fields the caller omits", async () => {
      const fake = world();
      const {
        enabled: _e,
        maxRunsToKeep: _m,
        search: _s,
        includeMemories: _i,
        ...required
      } = cronFields();

      await createTrigger(ctx, required);

      expect(fake.tables.trigger[0]).toMatchObject({
        enabled: true,
        maxRunsToKeep: 10,
        search: false,
        includeMemories: false,
      });
    });

    it("throws ValidationError for an invalid cron expression", async () => {
      world();
      await expect(
        createTrigger(ctx, {
          ...cronFields(),
          config: {
            cronExpression: "invalid",
            timezone: "UTC",
            isOneOff: false,
          },
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError when cronExpression is missing", async () => {
      world();
      await expect(
        createTrigger(ctx, { ...cronFields(), config: {} as never }),
      ).rejects.toThrow(ValidationError);
    });

    it("inserts an event trigger with a full filters shape (columnId, changedFields)", async () => {
      const fake = world();
      const config: TriggerCreateFields["config"] = {
        events: ["card.created", "card.updated"],
        filters: {
          boardId: "board-1",
          columnId: "col-1",
          changedFields: ["title", "body"],
        },
      };

      await createTrigger(ctx, { ...eventFields(), config });

      expect(fake.tables.trigger[0]).toMatchObject({
        config,
        nextRunAt: null,
      });
    });

    it("throws ValidationError for an empty events array", async () => {
      world();
      await expect(
        createTrigger(ctx, { ...eventFields(), config: { events: [] } }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError for an event name outside the real enum", async () => {
      world();
      await expect(
        createTrigger(ctx, {
          ...eventFields(),
          config: { events: ["card.commented"] as never },
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError for a filters object with an unknown-shaped field", async () => {
      world();
      await expect(
        createTrigger(ctx, {
          ...eventFields(),
          config: {
            events: ["card.created"],
            filters: { changedFields: "not-an-array" as never },
          },
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError for an unrecognized trigger type", async () => {
      world();
      await expect(
        createTrigger(ctx, { ...cronFields(), type: "invalid" as never }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("updateTrigger", () => {
    it("throws NotFoundError when the trigger doesn't exist in this workspace", async () => {
      const fake = world({
        trigger: [triggerRow({ workspaceId: "ws-2", name: "Theirs" })],
      });

      await expect(updateTrigger(ctx, "trig-1", { name: "x" })).rejects.toThrow(
        NotFoundError,
      );
      expect(fake.tables.trigger[0].name).toBe("Theirs");
    });

    it("checks the trigger exists before the agent", async () => {
      world();

      await expect(
        updateTrigger(ctx, "trig-missing", { agentId: "agent-missing" }),
      ).rejects.toThrow(NotFoundError);
    });

    it.each(["shared-unattached", "agent-other"])(
      "rejects an agent change to %s and leaves the row unchanged",
      async (agentId) => {
        const fake = world({ trigger: [triggerRow()] });

        await expect(
          updateTrigger(ctx, "trig-1", { agentId, name: "Renamed" }),
        ).rejects.toThrow(
          new ValidationError("Agent not found in this workspace"),
        );
        expect(fake.tables.trigger[0]).toMatchObject({
          agentId: "agent-1",
          name: "Daily",
        });
      },
    );

    it("accepts an agent change to a Shared agent attached here", async () => {
      const fake = world({ trigger: [triggerRow()] });

      await updateTrigger(ctx, "trig-1", { agentId: "shared-attached" });

      expect(fake.tables.trigger[0].agentId).toBe("shared-attached");
    });

    it("does not check the agent when agentId is omitted", async () => {
      // The stored agent is gone; an update that doesn't touch it still lands.
      const fake = world({
        trigger: [triggerRow({ agentId: "agent-deleted" })],
      });

      await updateTrigger(ctx, "trig-1", { name: "Renamed" });

      expect(fake.tables.trigger[0].name).toBe("Renamed");
    });

    it("writes every scalar field the update carries", async () => {
      const fake = world({ trigger: [triggerRow()] });

      await updateTrigger(ctx, "trig-1", {
        description: "About it",
        instruction: "Do the other thing",
        enabled: false,
        maxRunsToKeep: 3,
        search: true,
        includeMemories: true,
      });

      expect(fake.tables.trigger[0]).toMatchObject({
        description: "About it",
        instruction: "Do the other thing",
        enabled: false,
        maxRunsToKeep: 3,
        search: true,
        includeMemories: true,
        updatedAt: expect.any(Date) as unknown,
      });
    });

    it("refuses to update a stored row of an unknown type unless the update names one", async () => {
      const fake = world({
        trigger: [triggerRow({ type: "webhook", name: "Legacy" })],
      });

      await expect(
        updateTrigger(ctx, "trig-1", { name: "Renamed" }),
      ).rejects.toThrow(
        new ValidationError(
          "Invalid trigger type. Must be 'cron', 'event' or 'inbound'.",
        ),
      );
      expect(fake.tables.trigger[0].name).toBe("Legacy");
    });

    it("recomputes nextRunAt when a cron trigger's config changes", async () => {
      const fake = world({ trigger: [triggerRow()] });

      const row = await updateTrigger(ctx, "trig-1", {
        name: "Updated",
        config: {
          cronExpression: "0 10 * * *",
          timezone: "UTC",
          isOneOff: false,
        },
      });

      expect(row).toMatchObject({ name: "Updated", nextRunAt: NEXT_RUN });
      expect(fake.tables.trigger[0].nextRunAt).toEqual(NEXT_RUN);
    });

    it("leaves nextRunAt untouched when a cron trigger is disabled", async () => {
      const stale = new Date("2020-01-01T00:00:00Z");
      const fake = world({ trigger: [triggerRow({ nextRunAt: stale })] });

      await updateTrigger(ctx, "trig-1", { enabled: false });

      expect(fake.tables.trigger[0].nextRunAt).toEqual(stale);
    });

    it("recomputes nextRunAt when a disabled cron trigger is enabled", async () => {
      // The regression: disabling leaves `nextRunAt` in the past, so without a
      // recompute here the scheduler's `nextRunAt <= NOW()` due query fires an
      // off-schedule catch-up run on the next tick.
      const fake = world({
        trigger: [
          triggerRow({
            enabled: false,
            nextRunAt: new Date("2020-01-01T00:00:00Z"),
          }),
        ],
      });

      await updateTrigger(ctx, "trig-1", { enabled: true });

      expect(fake.tables.trigger[0].nextRunAt).toEqual(NEXT_RUN);
    });

    it("leaves nextRunAt untouched when an already-enabled cron trigger is updated", async () => {
      // Only the false -> true edge restarts the schedule. A no-op `enabled:
      // true` on a running Trigger must not push its next run out.
      const current = new Date("2026-06-01T09:00:00Z");
      const fake = world({ trigger: [triggerRow({ nextRunAt: current })] });

      await updateTrigger(ctx, "trig-1", { enabled: true, name: "Renamed" });

      expect(fake.tables.trigger[0].nextRunAt).toEqual(current);
    });

    it("does not recompute nextRunAt when an event trigger is enabled", async () => {
      // Event triggers have no schedule; enabling one must still clear it.
      const fake = world({
        trigger: [
          triggerRow({
            type: "event",
            enabled: false,
            config: { events: ["card.created"] },
          }),
        ],
      });

      await updateTrigger(ctx, "trig-1", { enabled: true });

      expect(fake.tables.trigger[0].nextRunAt).toBeNull();
    });

    it("throws ValidationError for an invalid cron expression on update", async () => {
      world({ trigger: [triggerRow()] });

      await expect(
        updateTrigger(ctx, "trig-1", {
          config: {
            cronExpression: "invalid",
            timezone: "UTC",
            isOneOff: false,
          },
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("clears nextRunAt when switching to event type", async () => {
      const fake = world({ trigger: [triggerRow({ nextRunAt: NEXT_RUN })] });

      await updateTrigger(ctx, "trig-1", {
        type: "event",
        config: { events: ["card.created"] },
      });

      expect(fake.tables.trigger[0]).toMatchObject({
        type: "event",
        nextRunAt: null,
      });
    });

    // A type change re-reads the stored config under the other shape's schema.
    // Without it, a cron config survives under `type: "event"`: the cron
    // scheduler skips it (nextRunAt is nulled) and the event dispatcher never
    // matches it (no `events`), so the Trigger looks configured and can never
    // fire. The cron branch already guarded the mirror case.
    it("throws ValidationError when flipping to event type without a config", async () => {
      world({ trigger: [triggerRow()] });

      await expect(
        updateTrigger(ctx, "trig-1", { type: "event" }),
      ).rejects.toThrow(ValidationError);
    });

    // The mirror of the above, kept alongside it so the symmetry is visible.
    it("throws ValidationError when flipping to cron type without a config", async () => {
      world({
        trigger: [
          triggerRow({ type: "event", config: { events: ["card.created"] } }),
        ],
      });

      await expect(
        updateTrigger(ctx, "trig-1", { type: "cron" }),
      ).rejects.toThrow(ValidationError);
    });

    // The guard keys on the type *field being present*, not on it changing, so
    // a caller that re-sends the type it already has must still succeed — the
    // stored config revalidates cleanly under its own schema.
    it("accepts a no-op event type on update, leaving the stored config alone", async () => {
      const config = { events: ["card.created"], filters: { boardId: "b-1" } };
      const fake = world({ trigger: [triggerRow({ type: "event", config })] });

      await updateTrigger(ctx, "trig-1", { type: "event", name: "renamed" });

      expect(fake.tables.trigger[0]).toMatchObject({ name: "renamed", config });
    });

    it("throws ValidationError for an empty events array on update", async () => {
      world({
        trigger: [
          triggerRow({ type: "event", config: { events: ["card.created"] } }),
        ],
      });

      await expect(
        updateTrigger(ctx, "trig-1", { config: { events: [] } }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError for an event name outside the real enum on update", async () => {
      world({
        trigger: [
          triggerRow({ type: "event", config: { events: ["card.created"] } }),
        ],
      });

      await expect(
        updateTrigger(ctx, "trig-1", {
          config: { events: ["card.commented"] as never },
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("round-trips a columnId/changedFields filter through a full-replace config update", async () => {
      const fake = world({
        trigger: [
          triggerRow({
            type: "event",
            config: {
              events: ["card.created"],
              filters: { boardId: "board-1" },
            },
          }),
        ],
      });
      const newConfig: TriggerUpdateFields["config"] = {
        events: ["card.updated"],
        filters: {
          boardId: "board-1",
          columnId: "col-2",
          changedFields: ["priority"],
        },
      };

      await updateTrigger(ctx, "trig-1", { config: newConfig });

      expect(fake.tables.trigger[0].config).toEqual(newConfig);
    });

    it("replaces config wholesale rather than merging — omitting filters on update drops the old ones", async () => {
      const fake = world({
        trigger: [
          triggerRow({
            type: "event",
            config: {
              events: ["card.created"],
              filters: { boardId: "board-1", columnId: "col-1" },
            },
          }),
        ],
      });

      await updateTrigger(ctx, "trig-1", {
        config: { events: ["card.created", "card.updated"] },
      });

      expect(fake.tables.trigger[0].config).toEqual({
        events: ["card.created", "card.updated"],
      });
    });
  });

  describe("listTriggers", () => {
    const rows = () => ({
      trigger: [
        triggerRow({ id: "old", createdAt: new Date("2026-01-01") }),
        triggerRow({
          id: "new-off",
          enabled: false,
          createdAt: new Date("2026-03-01"),
        }),
        triggerRow({ id: "mid", createdAt: new Date("2026-02-01") }),
        triggerRow({
          id: "theirs",
          workspaceId: "ws-2",
          createdAt: new Date("2026-04-01"),
        }),
      ],
    });

    it("returns only this workspace's triggers, newest first", async () => {
      world(rows());

      const result = await listTriggers(ctx);

      expect(result.map((t) => t.id)).toEqual(["new-off", "mid", "old"]);
    });

    it("filters to enabled triggers with enabledOnly", async () => {
      world(rows());

      const result = await listTriggers(ctx, { enabledOnly: true });

      expect(result.map((t) => t.id)).toEqual(["mid", "old"]);
    });
  });

  describe("one-off triggers", () => {
    const oneOffConfig = {
      cronExpression: "0 9 1 1 *",
      timezone: "UTC",
      isOneOff: true,
    };
    const oneOffFields = (): TriggerCreateFields => ({
      ...cronFields(),
      config: oneOffConfig,
    });
    const pending = (n: number, over: Row = {}) =>
      Array.from({ length: n }, (_, i) =>
        triggerRow({ id: `once-${i}`, config: oneOffConfig, ...over }),
      );
    const fired = (over: Row = {}) =>
      triggerRow({
        id: "fired",
        config: oneOffConfig,
        enabled: false,
        firedAt: new Date("2026-01-01T09:00:00Z"),
        ...over,
      });

    it("refuses the 51st pending One-off in a workspace, naming the limit", async () => {
      world({ trigger: pending(50) });

      await expect(createTrigger(ctx, oneOffFields())).rejects.toThrow(
        ValidationError,
      );
      await expect(createTrigger(ctx, oneOffFields())).rejects.toThrow(/50/);
    });

    it("counts a One-off disabled before it fired, but not a fired one or another workspace's", async () => {
      const fake = world({
        trigger: [
          ...pending(48),
          triggerRow({ id: "off", config: oneOffConfig, enabled: false }),
          fired(),
          triggerRow({
            id: "theirs",
            workspaceId: "ws-2",
            config: oneOffConfig,
          }),
        ],
      });

      await createTrigger(ctx, oneOffFields());

      await expect(createTrigger(ctx, oneOffFields())).rejects.toThrow(/50/);
      expect(fake.tables.trigger).toHaveLength(52);
    });

    it("refuses converting a recurring Trigger into a One-off past the limit", async () => {
      world({ trigger: [...pending(50), triggerRow()] });

      await expect(
        updateTrigger(ctx, "trig-1", { config: oneOffConfig }),
      ).rejects.toThrow(/50/);
    });

    it("lets a pending One-off at the limit be edited", async () => {
      world({ trigger: pending(50) });

      await expect(
        updateTrigger(ctx, "once-0", { config: oneOffConfig, name: "Renamed" }),
      ).resolves.toMatchObject({ name: "Renamed" });
    });

    it.each([
      ["re-enabling", { enabled: true }],
      [
        "rescheduling",
        { config: { ...oneOffConfig, cronExpression: "0 10 1 1 *" } },
      ],
      ["making it recurring", { config: { ...oneOffConfig, isOneOff: false } }],
      [
        "changing its type",
        { type: "event", config: { events: ["card.created"] } },
      ],
    ] as [string, TriggerUpdateFields][])(
      "refuses %s a fired One-off",
      async (_label, fields) => {
        world({ trigger: [fired()] });

        await expect(updateTrigger(ctx, "fired", fields)).rejects.toThrow(
          ValidationError,
        );
      },
    );

    it("allows renaming a fired One-off with its config unchanged, and deleting it", async () => {
      world({ trigger: [fired()] });

      await expect(
        updateTrigger(ctx, "fired", {
          name: "Renamed",
          enabled: false,
          config: oneOffConfig,
        }),
      ).resolves.toMatchObject({ name: "Renamed", enabled: false });
      await expect(deleteTrigger(ctx, "fired")).resolves.toBe(true);
    });

    it("hides fired One-offs from the list unless includeFired is set", async () => {
      world({ trigger: [fired(), triggerRow()] });

      expect((await listTriggers(ctx)).map((t) => t.id)).toEqual(["trig-1"]);
      expect(
        (await listTriggers(ctx, { includeFired: true })).map((t) => t.id),
      ).toEqual(["fired", "trig-1"]);
    });

    it("lists each Trigger with its newest run's status", async () => {
      world({
        trigger: [fired(), triggerRow()],
        trigger_run: [
          {
            id: "r-old",
            triggerId: "fired",
            status: "running",
            startedAt: new Date("2026-01-01T09:00:00Z"),
          },
          {
            id: "r-new",
            triggerId: "fired",
            status: "failed",
            startedAt: new Date("2026-01-02T09:00:00Z"),
          },
        ],
      });

      const result = await listTriggers(ctx, { includeFired: true });

      expect(
        result.map(({ id, lastRunStatus }) => ({ id, lastRunStatus })),
      ).toEqual([
        { id: "fired", lastRunStatus: "failed" },
        { id: "trig-1", lastRunStatus: null },
      ]);
    });
  });

  describe("getTrigger", () => {
    it("returns this workspace's trigger", async () => {
      world({ trigger: [triggerRow()] });

      expect(await getTrigger(ctx, "trig-1")).toMatchObject({ id: "trig-1" });
    });

    it("throws NotFoundError for another workspace's trigger", async () => {
      world({ trigger: [triggerRow({ workspaceId: "ws-2" })] });

      await expect(getTrigger(ctx, "trig-1")).rejects.toThrow(NotFoundError);
    });
  });

  describe("deleteTrigger", () => {
    it("deletes this workspace's trigger", async () => {
      const fake = world({ trigger: [triggerRow()] });

      expect(await deleteTrigger(ctx, "trig-1")).toBe(true);
      expect(fake.tables.trigger).toHaveLength(0);
    });

    it("returns false and leaves another workspace's trigger intact", async () => {
      const fake = world({ trigger: [triggerRow({ workspaceId: "ws-2" })] });

      expect(await deleteTrigger(ctx, "trig-1")).toBe(false);
      expect(fake.tables.trigger).toHaveLength(1);
    });

    it("refuses an Inbound Trigger unless the caller is the Owner's surface", async () => {
      // An inbound run's context carries caller text: an Agent talked into
      // deleting its own integration would stop it silently.
      const fake = world({ trigger: [triggerRow({ type: "inbound" })] });

      await expect(deleteTrigger(ctx, "trig-1")).rejects.toThrow(
        ValidationError,
      );
      expect(fake.tables.trigger).toHaveLength(1);

      expect(await deleteTrigger(ctx, "trig-1", { allowInbound: true })).toBe(
        true,
      );
      expect(fake.tables.trigger).toHaveLength(0);
    });
  });

  describe("inbound triggers", () => {
    const DAY = 24 * 60 * 60 * 1000;

    it("is refused unless the caller is the Owner's surface", async () => {
      const fake = world();

      await expect(createTrigger(ctx, inboundFields())).rejects.toThrow(
        ValidationError,
      );
      expect(fake.tables.trigger ?? []).toEqual([]);
    });

    it("issues a token once and stores only its hash, with the chosen lifetime", async () => {
      const fake = world();

      const row = await createTrigger(ctx, inboundFields(), {
        allowInbound: true,
      });

      expect(row.issuedToken).toMatch(/^pit_[A-Za-z0-9_-]{43}$/);
      const [stored] = fake.tables.trigger;
      expect(stored.tokenHash).toBe(hashBearerToken(row.issuedToken!));
      expect(JSON.stringify(stored)).not.toContain(row.issuedToken!);
      const lifetime =
        (stored.tokenExpiresAt as Date).getTime() -
        (stored.tokenCreatedAt as Date).getTime();
      expect(lifetime).toBe(30 * DAY);
      expect(stored.nextRunAt).toBeNull();
    });

    it.each([
      [
        "a record key naming an optional input",
        {
          inputs: [{ name: "issueKey", required: false }],
          recordKey: "issueKey",
        },
      ],
      ["a record key naming no input", { inputs: [], recordKey: "issueKey" }],
      ["a duplicated input name", { inputs: [{ name: "a" }, { name: "a" }] }],
      [
        "an input name that is not an identifier",
        { inputs: [{ name: "issue-key" }] },
      ],
      ["a lifetime that is not a preset", { tokenExpiryDays: 45 }],
    ])("refuses %s", async (_label, config) => {
      const fake = world();

      await expect(
        createTrigger(
          ctx,
          { ...inboundFields(), config: config as never },
          { allowInbound: true },
        ),
      ).rejects.toThrow(ValidationError);
      expect(fake.tables.trigger ?? []).toEqual([]);
    });

    it("refuses an Agent-surface edit of an Inbound Trigger", async () => {
      world({ trigger: [triggerRow({ type: "inbound", config: {} })] });

      await expect(
        updateTrigger(ctx, "trig-1", { name: "Renamed" }),
      ).rejects.toThrow(ValidationError);
    });

    it.each([
      ["into inbound", "cron", "inbound"],
      ["out of inbound", "inbound", "cron"],
    ] as const)(
      "refuses a type change %s on any surface",
      async (_l, from, to) => {
        world({ trigger: [triggerRow({ type: from, config: {} })] });

        await expect(
          updateTrigger(ctx, "trig-1", { type: to }, { allowInbound: true }),
        ).rejects.toThrow(/cannot be changed to or from 'inbound'/);
      },
    );

    it("keeps the live token's expiry when the Owner changes the lifetime", async () => {
      const expires = new Date("2026-12-01T00:00:00Z");
      const fake = world({
        trigger: [
          triggerRow({
            type: "inbound",
            config: { inputs: [], tokenExpiryDays: 90 },
            tokenHash: "h",
            tokenExpiresAt: expires,
          }),
        ],
      });

      await updateTrigger(
        ctx,
        "trig-1",
        { config: { inputs: [], tokenExpiryDays: 365 } },
        { allowInbound: true },
      );

      expect(fake.tables.trigger[0]).toMatchObject({
        tokenHash: "h",
        tokenExpiresAt: expires,
        config: { inputs: [], tokenExpiryDays: 365 },
      });
    });

    it("regenerates: a new token, the old hash gone, the notice record cleared", async () => {
      const fake = world({
        trigger: [
          triggerRow({
            type: "inbound",
            config: { inputs: [], tokenExpiryDays: 180 },
            tokenHash: "old-hash",
            tokenNotice: "expiring_7",
          }),
        ],
      });

      const { token, tokenExpiresAt } = await regenerateTriggerToken(
        ctx,
        "trig-1",
      );

      const [stored] = fake.tables.trigger;
      expect(stored.tokenHash).toBe(hashBearerToken(token));
      expect(stored.tokenNotice).toBeNull();
      expect(stored.tokenExpiresAt).toEqual(tokenExpiresAt);
      expect(
        tokenExpiresAt.getTime() - (stored.tokenCreatedAt as Date).getTime(),
      ).toBe(180 * DAY);
    });

    it("regenerates only an inbound trigger in this workspace", async () => {
      world({
        trigger: [
          triggerRow(),
          triggerRow({
            id: "trig-2",
            workspaceId: "ws-2",
            type: "inbound",
            config: {},
          }),
        ],
      });

      await expect(regenerateTriggerToken(ctx, "trig-1")).rejects.toThrow(
        ValidationError,
      );
      await expect(regenerateTriggerToken(ctx, "trig-2")).rejects.toThrow(
        NotFoundError,
      );
    });

    it("answers a malformed stored config with a ValidationError, not a crash", async () => {
      world({
        trigger: [
          triggerRow({
            type: "inbound",
            config: { inputs: "not a list" },
            tokenHash: "old-hash",
          }),
        ],
      });

      await expect(regenerateTriggerToken(ctx, "trig-1")).rejects.toThrow(
        ValidationError,
      );
    });

    it("refuses another type's config for an Inbound Trigger rather than reading it as no inputs", async () => {
      world({
        trigger: [
          triggerRow({
            type: "inbound",
            config: { inputs: [], tokenExpiryDays: 90 },
            tokenHash: "h",
          }),
        ],
      });

      await expect(
        updateTrigger(
          ctx,
          "trig-1",
          { config: { cronExpression: "* * * * *" } },
          { allowInbound: true },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it("never exposes the hash through the public projection", () => {
      const row = {
        ...triggerRow(),
        tokenHash: "secret",
        tokenNotice: "expired",
      } as unknown as TriggerRow;

      const exposed = toPublicTrigger(row);

      expect(exposed).not.toHaveProperty("tokenHash");
      expect(exposed).not.toHaveProperty("tokenNotice");
    });
  });
});
