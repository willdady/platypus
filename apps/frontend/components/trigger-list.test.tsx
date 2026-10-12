import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import type { Trigger } from "@platypus/schemas";
import {
  authMock,
  toastMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  confirmDialog,
  stubAcceptedSave,
  stubRejectedSave,
  mutate,
  toastError,
} from "@/lib/list-test-harness";
import { selectOption } from "@/lib/test-utils";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);
// The list renders the stored `nextRunAt` through this formatter; stubbing it
// keeps the assertion independent of the viewer's locale and time zone.
vi.mock("@/lib/format-date", () => ({
  formatDateTime: (value: Date | string | number) =>
    `formatted:${new Date(value).toISOString()}`,
}));

// Likewise for the last run's relative time, which would otherwise move with
// the clock.
vi.mock("@/lib/relative-time", () => ({
  formatRelativeTime: (value: Date | string | number) =>
    `relative:${new Date(value).toISOString()}`,
}));

import { TriggerList } from "./trigger-list";

// --- Fixtures ----------------------------------------------------------------

const cronTrigger: Trigger = {
  id: "t1",
  name: "Nightly job",
  type: "cron",
  enabled: true,
  agentId: "agent1",
  config: { cronExpression: "0 0 * * *", timezone: "UTC" },
} as unknown as Trigger;

const nextRunAt = new Date("2026-02-01T09:00:00.000Z");
const scheduledTrigger: Trigger = {
  ...cronTrigger,
  nextRunAt,
} as unknown as Trigger;

function renderTriggers(triggers: Trigger[], menuItem?: string) {
  mockScopedSWR({ "/triggers": triggers });
  return renderList(<TriggerList orgId="org1" workspaceId="ws1" />, menuItem);
}

beforeEach(resetListHarness);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("TriggerList delete", () => {
  it("deletes through the request module and revalidates on success", async () => {
    const fetchMock = stubAcceptedSave();

    renderTriggers([cronTrigger], "Delete");
    await confirmDialog("Delete");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/triggers/t1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("surfaces the backend's reason inline and does not revalidate when delete is refused", async () => {
    stubRejectedSave("Trigger is in use", 409);

    renderTriggers([cronTrigger], "Delete");
    await confirmDialog("Delete");

    await waitFor(() =>
      expect(screen.getByText("Trigger is in use")).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
    // The dialog stays open on a refused delete, letting the user retry.
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });
});

describe("TriggerList toggle enabled", () => {
  it("PUTs the flipped enabled flag and revalidates on success", async () => {
    const fetchMock = stubAcceptedSave();

    renderTriggers([cronTrigger], "Disable");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/triggers/t1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      }),
    );
  });

  it("surfaces the backend's reason and does not flip when the toggle is refused", async () => {
    stubRejectedSave("Trigger is running", 409);

    renderTriggers([cronTrigger], "Disable");

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Trigger is running"),
    );
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("TriggerList cron schedule", () => {
  it("describes the schedule in plain English with the next run", () => {
    renderTriggers([scheduledTrigger]);

    expect(screen.getByText("At 12:00 AM (UTC)")).toBeInTheDocument();
    expect(
      screen.getByText("Next: formatted:2026-02-01T09:00:00.000Z"),
    ).toBeInTheDocument();
  });

  it("keeps the raw expression reachable as a tooltip", () => {
    renderTriggers([scheduledTrigger]);

    expect(screen.getByTitle("0 0 * * *")).toBeInTheDocument();
  });

  it("falls back to the raw expression when cron cannot be parsed", () => {
    renderTriggers([
      {
        ...scheduledTrigger,
        config: { cronExpression: "nonsense", timezone: "UTC" },
      } as unknown as Trigger,
    ]);

    expect(screen.getByText("nonsense")).toBeInTheDocument();
  });

  it("describes the schedule without a next run when the trigger is disabled", () => {
    renderTriggers([{ ...scheduledTrigger, enabled: false } as Trigger]);

    expect(screen.getByText("At 12:00 AM (UTC)")).toBeInTheDocument();
    expect(screen.queryByText(/Next:/)).not.toBeInTheDocument();
  });

  it("describes the schedule without a next run when none is scheduled", () => {
    renderTriggers([{ ...scheduledTrigger, nextRunAt: null } as Trigger]);

    expect(screen.getByText("At 12:00 AM (UTC)")).toBeInTheDocument();
    expect(screen.queryByText(/Next:/)).not.toBeInTheDocument();
  });
});

describe("TriggerList list states", () => {
  // No controls with nothing to filter.
  it("says so, without controls, when the workspace has no triggers", () => {
    renderTriggers([]);

    expect(screen.getByText("No triggers yet.")).toBeInTheDocument();

    expect(
      screen.queryByRole("switch", { name: "Show fired" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Filter by type" }),
    ).not.toBeInTheDocument();
  });

  // Fired One-offs are hidden by default; Show fired must stay reachable.
  it("keeps the controls when only fired One-offs exist, and Show fired lists them", async () => {
    renderTriggers([
      {
        ...cronTrigger,
        enabled: false,
        config: { ...cronTrigger.config, isOneOff: true },
        firedAt: "2026-02-01T08:00:00.000Z",
      } as unknown as Trigger,
    ]);

    expect(screen.queryByRole("listitem")).toBeNull();
    const showFired = screen.getByRole("switch", { name: "Show fired" });
    await act(async () => {
      showFired.click();
    });
    expect(screen.getByText("Nightly job")).toBeInTheDocument();
  });

  it("surfaces a failed read rather than rendering an empty list", () => {
    mockScopedSWR({ "/triggers": { error: new Error("500") } });
    renderList(<TriggerList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText(/Failed to load triggers/)).toBeInTheDocument();
  });

  it("holds the grid with a skeleton while the read is in flight", () => {
    mockScopedSWR({ "/triggers": { isLoading: true } });
    renderList(<TriggerList orgId="org1" workspaceId="ws1" />);

    expect(
      screen.getByRole("status", { name: "Loading triggers" }),
    ).toHaveAttribute("aria-busy", "true");
  });

  // A revalidation keeps the list it has rather than flashing to the
  // skeleton and back.
  it("keeps the list it has while a re-read is in flight", () => {
    mockScopedSWR({
      "/triggers": { data: { results: [cronTrigger] }, isLoading: true },
    });
    renderList(<TriggerList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText("Nightly job")).toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: "Loading triggers" }),
    ).not.toBeInTheDocument();
  });
});

describe("TriggerList inbound triggers", () => {
  const inboundTrigger = (over: Record<string, unknown> = {}): Trigger =>
    ({
      id: "t2",
      name: "Ready for AI",
      type: "inbound",
      enabled: true,
      agentId: "agent1",
      config: {
        inputs: [{ name: "issueKey", required: true }],
        recordKey: "issueKey",
        tokenExpiryDays: 90,
      },
      tokenStatus: "active",
      tokenExpiresAt: new Date(Date.now() + 80 * 24 * 60 * 60 * 1000),
      ...over,
    }) as unknown as Trigger;

  it("renders an Inbound Trigger with its own badge and its inputs, not as an Event Trigger", () => {
    renderTriggers([inboundTrigger()]);

    expect(screen.getByText("Inbound")).toBeInTheDocument();
    expect(screen.queryByText("Event")).toBeNull();
    expect(screen.getByText("issueKey")).toBeInTheDocument();
    expect(screen.queryByText(/Called from outside/)).toBeNull();
  });

  it("draws no summary line for an input-less Trigger with a healthy token", () => {
    renderTriggers([inboundTrigger({ config: { inputs: [] } })]);

    expect(screen.queryByText(/Inputs:|Token/)).toBeNull();
  });

  it("flags a trigger whose token was revoked or has expired", () => {
    renderTriggers([
      inboundTrigger({
        id: "t3",
        name: "Revoked",
        tokenStatus: "none",
      }),
      inboundTrigger({
        id: "t4",
        name: "Old",
        tokenStatus: "expired",
        tokenExpiresAt: new Date(Date.now() - 1000),
      }),
    ]);

    expect(screen.getByText("No token")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
  });
});

describe("TriggerList type filter", () => {
  const eventTrigger = {
    id: "t5",
    name: "Card watcher",
    type: "event",
    enabled: true,
    agentId: "agent1",
    config: { events: ["card.created"] },
  } as unknown as Trigger;

  it("lists every type until one is picked", () => {
    renderTriggers([cronTrigger, eventTrigger]);

    expect(
      screen.getByRole("combobox", { name: "Filter by type" }),
    ).toHaveTextContent("All types");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("narrows the list to the chosen type", async () => {
    renderTriggers([cronTrigger, eventTrigger]);

    await act(async () => {
      await selectOption("All types", "Event");
    });

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Card watcher")).toBeInTheDocument();
    expect(screen.queryByText("Nightly job")).toBeNull();
  });

  it("disables Show fired for the types that never fire", async () => {
    renderTriggers([cronTrigger, eventTrigger]);
    const showFired = screen.getByRole("switch", { name: "Show fired" });

    await act(async () => {
      await selectOption("All types", "Event");
    });
    expect(showFired).toBeDisabled();

    await act(async () => {
      await selectOption("Event", "Cron");
    });
    expect(showFired).toBeEnabled();
  });

  // A filter that matches nothing must say so, and leave the way back visible.
  it("says nothing matches and keeps the controls when no trigger has the type", async () => {
    renderTriggers([cronTrigger]);

    await act(async () => {
      await selectOption("All types", "Inbound");
    });

    expect(
      screen.getByText("No Inbound triggers to show."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "Filter by type" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Show fired" }),
    ).toBeInTheDocument();
  });
});

describe("TriggerList last run", () => {
  const startedAt = "2026-02-01T08:00:00.000Z";
  const ran = (trigger: Record<string, unknown>, status = "success"): Trigger =>
    ({
      enabled: true,
      agentId: "agent1",
      lastRunStatus: status,
      lastRunStartedAt: startedAt,
      ...trigger,
    }) as unknown as Trigger;

  const lastRunLine = (name: string) =>
    within(screen.getByText(name).closest("li") as HTMLElement).queryByText(
      "Last run:",
    )?.parentElement ?? null;

  it("shows every type's last run status and when it started", () => {
    renderTriggers([
      ran({ ...cronTrigger }),
      ran(
        {
          id: "t5",
          name: "Card watcher",
          type: "event",
          config: { events: ["card.created"] },
        },
        "failed",
      ),
      ran(
        {
          id: "t2",
          name: "Ready for AI",
          type: "inbound",
          config: { inputs: [], recordKey: "", tokenExpiryDays: 90 },
          tokenStatus: "active",
        },
        "running",
      ),
    ]);

    for (const [name, label] of [
      ["Nightly job", "Success"],
      ["Card watcher", "Failed"],
      ["Ready for AI", "Running"],
    ]) {
      const line = lastRunLine(name) as HTMLElement;
      expect(
        within(line).getByRole("img", { name: label }),
      ).toBeInTheDocument();
      expect(line).toHaveTextContent(`relative:${startedAt}`);
    }
    expect(screen.getAllByTitle(`formatted:${startedAt}`)).toHaveLength(3);
  });

  it("shows no last run line for a trigger that has never run", () => {
    renderTriggers([
      { ...cronTrigger, lastRunStatus: null, lastRunStartedAt: null },
    ]);

    expect(screen.queryByText("Last run:")).toBeNull();
  });

  it("keeps Fired in a fired One-off's title row and its status on the last run line", async () => {
    renderTriggers([
      ran(
        {
          ...cronTrigger,
          enabled: false,
          config: { ...cronTrigger.config, isOneOff: true },
          firedAt: "2026-02-01T08:00:00.000Z",
        },
        "failed",
      ),
    ]);

    await act(async () => {
      screen.getByRole("switch", { name: "Show fired" }).click();
    });

    expect(screen.getByText("Fired")).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "Failed" })).toHaveLength(1);
    expect(
      within(lastRunLine("Nightly job") as HTMLElement).getByRole("img", {
        name: "Failed",
      }),
    ).toBeInTheDocument();
  });

  it("shows both Disabled and the failure for a disabled trigger", () => {
    renderTriggers([ran({ ...cronTrigger, enabled: false }, "failed")]);

    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(
      within(lastRunLine("Nightly job") as HTMLElement).getByRole("img", {
        name: "Failed",
      }),
    ).toBeInTheDocument();
  });
});
