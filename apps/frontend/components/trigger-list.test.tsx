import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { Trigger } from "@platypus/schemas";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  confirmDialog,
  stubAcceptedSave,
  stubRejectedSave,
  mutate,
  push,
  toastError,
  menuItemLabels,
} from "@/test/list-test-harness";
import userEvent from "@testing-library/user-event";
import { openDropdownMenu, selectOption, setupUser } from "@/test/test-utils";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
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
};

function renderTriggers(triggers: Trigger[], menuItem?: string) {
  mockScopedSWR({ "/triggers": triggers });
  return renderList(<TriggerList orgId="org1" workspaceId="ws1" />, menuItem);
}

beforeEach(resetListHarness);

// --- Tests -------------------------------------------------------------------

describe("TriggerList delete", () => {
  it("deletes through the request module and revalidates on success", async () => {
    const fetchMock = stubAcceptedSave();

    await renderTriggers([cronTrigger], "Delete");
    await confirmDialog("Delete");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/triggers/t1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("surfaces the backend's reason inline and does not revalidate when delete is refused", async () => {
    stubRejectedSave("Trigger is in use", 409);

    await renderTriggers([cronTrigger], "Delete");
    await confirmDialog("Delete");

    expect(await screen.findByText("Trigger is in use")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
    // The dialog stays open on a refused delete, letting the user retry.
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });
});

describe("TriggerList clone", () => {
  // Run and token state a stored Trigger carries, none of which a clone may.
  const runState = {
    workspaceId: "ws1",
    description: null,
    instruction: "Do it",
    maxRunsToKeep: 10,
    search: false,
    includeMemories: true,
    lastRunAt: "2026-02-01T08:00:00.000Z",
    nextRunAt: "2026-02-02T08:00:00.000Z",
    lastRunStatus: "success",
    lastRunStartedAt: "2026-02-01T08:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const inboundTrigger = {
    ...cronTrigger,
    ...runState,
    id: "t2",
    name: "Ready for AI",
    type: "inbound",
    config: { inputs: [], tokenExpiryDays: 90 },
    tokenStatus: "active",
    tokenCreatedAt: "2026-01-01T00:00:00.000Z",
    tokenExpiresAt: "2026-04-01T00:00:00.000Z",
    lastUsedAt: "2026-02-01T08:00:00.000Z",
    lastRejectedAt: null,
  } as unknown as Trigger;

  const sentBody = (fetchMock: ReturnType<typeof stubAcceptedSave>): unknown =>
    JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);

  it("names the copy after the original", async () => {
    await renderTriggers([cronTrigger], "Clone");

    expect(screen.getByRole("dialog", { name: "Clone Trigger" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Nightly job (copy)",
    );
  });

  it("creates a disabled Cron copy without run state, then opens it", async () => {
    const fetchMock = stubAcceptedSave({ id: "t9" }, 201);

    // A fired One-off: its clone is a pending One-off, unfired.
    await renderTriggers([
      {
        ...cronTrigger,
        ...runState,
        config: { ...cronTrigger.config, isOneOff: true },
        firedAt: "2026-02-01T08:00:00.000Z",
      } as unknown as Trigger,
    ]);
    const user = setupUser();
    await user.click(screen.getByRole("switch", { name: "Show fired" }));
    await openDropdownMenu();
    await user.click(screen.getByRole("menuitem", { name: "Clone" }));
    await confirmDialog("Clone");

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/org1/workspace/ws1/triggers/t9"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/triggers",
      expect.objectContaining({ method: "POST" }),
    );
    expect(sentBody(fetchMock)).toEqual({
      workspaceId: "ws1",
      agentId: "agent1",
      type: "cron",
      name: "Nightly job (copy)",
      instruction: "Do it",
      maxRunsToKeep: 10,
      search: false,
      includeMemories: true,
      config: { cronExpression: "0 0 * * *", timezone: "UTC", isOneOff: true },
      enabled: false,
    });
  });

  it("creates a disabled Event copy that sends no token flag", async () => {
    const fetchMock = stubAcceptedSave({ id: "t9" }, 201);

    await renderTriggers(
      [
        {
          ...cronTrigger,
          ...runState,
          type: "event",
          config: { events: ["card.created"] },
        } as unknown as Trigger,
      ],
      "Clone",
    );
    await confirmDialog("Clone");

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(sentBody(fetchMock)).toMatchObject({
      type: "event",
      enabled: false,
    });
    expect(sentBody(fetchMock)).not.toHaveProperty("issueToken");
  });

  it("creates an Inbound copy that asks for no token", async () => {
    const fetchMock = stubAcceptedSave({ id: "t9" }, 201);

    await renderTriggers([inboundTrigger], "Clone");
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Renamed" } });
    await confirmDialog("Clone");

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(sentBody(fetchMock)).toEqual({
      workspaceId: "ws1",
      agentId: "agent1",
      type: "inbound",
      name: "Renamed",
      instruction: "Do it",
      maxRunsToKeep: 10,
      search: false,
      includeMemories: true,
      config: { inputs: [], tokenExpiryDays: 90 },
      enabled: false,
      issueToken: false,
    });
  });

  it("keeps the dialog open with the backend's reason when the create fails", async () => {
    stubRejectedSave("Too many pending one-off triggers", 400);

    await renderTriggers([cronTrigger], "Clone");
    await confirmDialog("Clone");

    expect(
      await screen.findByText("Too many pending one-off triggers"),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Clone Trigger" })).toBeVisible();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("TriggerList toggle enabled", () => {
  it("PUTs the flipped enabled flag and revalidates on success", async () => {
    const fetchMock = stubAcceptedSave();

    await renderTriggers([cronTrigger], "Disable");

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

    await renderTriggers([cronTrigger], "Disable");

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Trigger is running"),
    );
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("TriggerList cron schedule", () => {
  it("describes the schedule in plain English with the next run", async () => {
    await renderTriggers([scheduledTrigger]);

    expect(screen.getByText("At 12:00 AM (UTC)")).toBeInTheDocument();
    expect(
      screen.getByText("Next: formatted:2026-02-01T09:00:00.000Z"),
    ).toBeInTheDocument();
  });

  it("keeps the raw expression reachable as a tooltip", async () => {
    await renderTriggers([scheduledTrigger]);

    expect(screen.getByText("At 12:00 AM (UTC)")).toHaveAttribute(
      "title",
      "At 12:00 AM (UTC)\n0 0 * * *",
    );
  });

  it("falls back to the raw expression when cron cannot be parsed", async () => {
    await renderTriggers([
      {
        ...scheduledTrigger,
        config: { cronExpression: "nonsense", timezone: "UTC" },
      } as unknown as Trigger,
    ]);

    expect(screen.getByText("nonsense")).toBeInTheDocument();
  });

  it("describes the schedule without a next run when the trigger is disabled", async () => {
    await renderTriggers([{ ...scheduledTrigger, enabled: false }]);

    expect(screen.getByText("At 12:00 AM (UTC)")).toBeInTheDocument();
    expect(screen.queryByText(/Next:/)).not.toBeInTheDocument();
  });

  it("describes the schedule without a next run when none is scheduled", async () => {
    await renderTriggers([{ ...scheduledTrigger, nextRunAt: null }]);

    expect(screen.getByText("At 12:00 AM (UTC)")).toBeInTheDocument();
    expect(screen.queryByText(/Next:/)).not.toBeInTheDocument();
  });
});

describe("TriggerList list states", () => {
  // No controls with nothing to filter.
  it("says so, without controls, when the workspace has no triggers", async () => {
    await renderTriggers([]);

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
    await renderTriggers([
      {
        ...cronTrigger,
        enabled: false,
        config: { ...cronTrigger.config, isOneOff: true },
        firedAt: "2026-02-01T08:00:00.000Z",
      } as unknown as Trigger,
    ]);

    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    const showFired = screen.getByRole("switch", { name: "Show fired" });
    await act(async () => {
      showFired.click();
    });
    expect(screen.getByText("Nightly job")).toBeInTheDocument();
  });

  it("surfaces a failed read rather than rendering an empty list", async () => {
    mockScopedSWR({ "/triggers": { error: new Error("500") } });
    await renderList(<TriggerList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText(/Failed to load triggers/)).toBeInTheDocument();
  });

  it("holds the grid with a skeleton while the read is in flight", async () => {
    mockScopedSWR({ "/triggers": { isLoading: true } });
    await renderList(<TriggerList orgId="org1" workspaceId="ws1" />);

    expect(
      screen.getByRole("status", { name: "Loading triggers" }),
    ).toHaveAttribute("aria-busy", "true");
  });

  // A revalidation keeps the list it has rather than flashing to the
  // skeleton and back.
  it("keeps the list it has while a re-read is in flight", async () => {
    mockScopedSWR({
      "/triggers": { data: { results: [cronTrigger] }, isLoading: true },
    });
    await renderList(<TriggerList orgId="org1" workspaceId="ws1" />);

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

  it("renders an Inbound Trigger with its own badge and its input count, not as an Event Trigger", async () => {
    await renderTriggers([inboundTrigger()]);

    expect(screen.getByText("Inbound")).toBeInTheDocument();
    expect(screen.queryByText("Event")).not.toBeInTheDocument();
    expect(screen.getByText("1 input")).toBeInTheDocument();
    expect(screen.queryByText(/Called from outside/)).not.toBeInTheDocument();
  });

  it("counts several inputs and lists them in a tooltip", async () => {
    await renderTriggers([
      inboundTrigger({
        config: {
          inputs: [
            { name: "issueKey", required: true },
            { name: "summary", required: false },
          ],
          recordKey: "issueKey",
          tokenExpiryDays: 90,
        },
      }),
    ]);

    await userEvent.hover(screen.getByText("2 inputs"));
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("issueKey");
    expect(tooltip).toHaveTextContent("summary");
  });

  it("draws no summary line for an input-less Trigger with a healthy token", async () => {
    await renderTriggers([inboundTrigger({ config: { inputs: [] } })]);

    expect(screen.queryByText(/Inputs:|Token/)).not.toBeInTheDocument();
  });

  it("flags a trigger whose token was revoked or has expired", async () => {
    await renderTriggers([
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

describe("TriggerList event triggers", () => {
  const eventTrigger = (events: string[]) =>
    ({
      id: "t6",
      name: "Card watcher",
      type: "event",
      enabled: true,
      agentId: "agent1",
      config: { events },
    }) as unknown as Trigger;

  it("counts a single event", async () => {
    await renderTriggers([eventTrigger(["card.created"])]);

    expect(screen.getByText("1 event")).toBeInTheDocument();
  });

  it("counts several events and lists them in a tooltip", async () => {
    await renderTriggers([eventTrigger(["card.created", "card.moved"])]);

    await userEvent.hover(screen.getByText("2 events"));
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("card.created");
    expect(tooltip).toHaveTextContent("card.moved");
  });
});

describe("TriggerList card height", () => {
  it("reserves a two-line description box, with the full text on hover", async () => {
    await renderTriggers([{ ...cronTrigger, description: "Runs nightly" }]);

    const description = screen.getByText("Runs nightly");
    expect(description).toHaveClass("line-clamp-2", "min-h-[2lh]");
    expect(description).toHaveAttribute("title", "Runs nightly");
  });

  it("keeps the description box when there is no description", async () => {
    await renderTriggers([cronTrigger]);

    expect(screen.getByRole("paragraph")).toHaveClass("min-h-[2lh]");
  });

  it("draws a schedule, its next run and Last run in a two-line block", async () => {
    await renderTriggers([
      {
        ...scheduledTrigger,
        lastRunStatus: "success",
        lastRunStartedAt: new Date(),
      },
    ]);

    const block = screen.getByText((_, element) =>
      Boolean(element?.classList.contains("min-h-9")),
    );
    expect(block).toHaveTextContent(
      /^At 12:00 AM \(UTC\)·Next: formatted:2026-02-01T09:00:00\.000ZLast run:/,
    );
  });

  it("truncates the Trigger's name, with the full name on hover", async () => {
    await renderTriggers([cronTrigger]);

    const name = screen.getByText("Nightly job");
    expect(name).toHaveClass("truncate");
    expect(name).toHaveAttribute("title", "Nightly job");
  });

  it("truncates the agent's name, with the full name on hover", async () => {
    mockScopedSWR({ "/agents": [{ id: "agent1", name: "Agent One" }] });
    await renderTriggers([cronTrigger]);

    const name = screen.getByText("Agent One");
    expect(name).toHaveClass("truncate");
    expect(name).toHaveAttribute("title", "Agent One");
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

  it("lists every type until one is picked", async () => {
    await renderTriggers([cronTrigger, eventTrigger]);

    expect(
      screen.getByRole("combobox", { name: "Filter by type" }),
    ).toHaveTextContent("All types");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("narrows the list to the chosen type", async () => {
    await renderTriggers([cronTrigger, eventTrigger]);

    await act(async () => {
      await selectOption("All types", "Event");
    });

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Card watcher")).toBeInTheDocument();
    expect(screen.queryByText("Nightly job")).not.toBeInTheDocument();
  });

  it("disables Show fired for the types that never fire", async () => {
    await renderTriggers([cronTrigger, eventTrigger]);
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
    await renderTriggers([cronTrigger]);

    await act(async () => {
      await selectOption("All types", "Inbound");
    });

    expect(
      screen.getByText("No Inbound triggers to show."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Filter by type" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Show fired" }),
    ).toBeInTheDocument();
  });
});

describe("TriggerList filters in the URL", () => {
  const eventTrigger = {
    ...cronTrigger,
    id: "t5",
    name: "Card watcher",
    type: "event",
    config: { events: ["card.created"] },
  } as unknown as Trigger;
  const firedTrigger = {
    ...cronTrigger,
    id: "t6",
    name: "Launch reminder",
    enabled: false,
    config: { ...cronTrigger.config, isOneOff: true },
    firedAt: "2026-02-01T08:00:00.000Z",
  } as unknown as Trigger;

  it("writes the type and Show fired to the query string, leaving defaults out", async () => {
    const pushState = vi.spyOn(window.history, "pushState");
    await renderTriggers([cronTrigger, eventTrigger]);

    await act(async () => {
      await selectOption("All types", "Cron");
    });
    await act(async () => {
      screen.getByRole("switch", { name: "Show fired" }).click();
    });
    expect(window.location.search).toBe(
      "?triggerType=cron&triggerShowFired=true",
    );

    await act(async () => {
      await selectOption("Cron", "All types");
    });
    await act(async () => {
      screen.getByRole("switch", { name: "Show fired" }).click();
    });
    expect(window.location.search).toBe("");
    expect(pushState).not.toHaveBeenCalled();
  });

  it("reads the type and Show fired back from the query string", async () => {
    window.history.replaceState(
      null,
      "",
      "?triggerType=cron&triggerShowFired=true",
    );
    await renderTriggers([cronTrigger, eventTrigger, firedTrigger]);

    expect(
      screen.getByRole("combobox", { name: "Filter by type" }),
    ).toHaveTextContent("Cron");
    expect(screen.getByRole("switch", { name: "Show fired" })).toBeChecked();
    expect(screen.getByText("Launch reminder")).toBeInTheDocument();
    expect(screen.queryByText("Card watcher")).not.toBeInTheDocument();
  });

  it("falls back to the defaults for values it does not know", async () => {
    window.history.replaceState(
      null,
      "",
      "?triggerType=bogus&triggerShowFired=yes",
    );
    await renderTriggers([cronTrigger, eventTrigger, firedTrigger]);

    expect(
      screen.getByRole("combobox", { name: "Filter by type" }),
    ).toHaveTextContent("All types");
    expect(
      screen.getByRole("switch", { name: "Show fired" }),
    ).not.toBeChecked();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
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

  it("shows every type's last run status and when it started", async () => {
    await renderTriggers([
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

  it("says Never on the last run line for a trigger that has never run", async () => {
    await renderTriggers([
      { ...cronTrigger, lastRunStatus: null, lastRunStartedAt: null },
    ]);

    expect(screen.getByText("Last run:")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
  });

  it("keeps Fired in a fired One-off's title row and its status on the last run line", async () => {
    await renderTriggers([
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

  it("shows both Disabled and the failure for a disabled trigger", async () => {
    await renderTriggers([ran({ ...cronTrigger, enabled: false }, "failed")]);

    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(
      within(lastRunLine("Nightly job") as HTMLElement).getByRole("img", {
        name: "Failed",
      }),
    ).toBeInTheDocument();
  });
});

describe("TriggerList card", () => {
  it("opens the trigger's runs when the card is clicked", async () => {
    await renderTriggers([cronTrigger]);

    expect(screen.getByRole("link", { name: /Nightly job/ })).toHaveAttribute(
      "href",
      "/org1/workspace/ws1/trigger-runs?triggerId=t1",
    );
  });

  it("orders its menu Edit, Clone, Enable/Disable, then Delete, with no View runs", async () => {
    await renderTriggers([cronTrigger]);
    await openDropdownMenu();

    expect(menuItemLabels()).toEqual(["Edit", "Clone", "Disable", "Delete"]);
  });
});

describe("TriggerList paging", () => {
  // Eight Cron triggers, "trigger-1" … "trigger-8": two pages of six.
  const eight = Array.from({ length: 8 }, (_, i) => ({
    ...cronTrigger,
    id: `t${i + 1}`,
    name: `trigger-${i + 1}`,
  }));
  const shownNames = () =>
    eight.map((t) => t.name).filter((name) => screen.queryByText(name));
  const pages = () =>
    screen.queryByRole("navigation", { name: "Triggers pages" });

  it("shows six triggers and pages to the rest", async () => {
    await renderTriggers(eight);

    expect(shownNames()).toHaveLength(6);
    expect(pages()).toHaveTextContent("Page 1 of 2");

    await setupUser().click(screen.getByRole("button", { name: "Next page" }));

    expect(window.location.search).toBe("?triggersPage=2");
    expect(shownNames()).toEqual(["trigger-7", "trigger-8"]);
  });

  it("returns to page 1 when the type filter changes", async () => {
    window.history.replaceState(null, "", "?triggersPage=2");
    await renderTriggers(eight);

    await selectOption("All types", "Cron");

    expect(window.location.search).toBe("?triggerType=cron");
    expect(pages()).toHaveTextContent("Page 1 of 2");
  });

  it("draws no page controls for six triggers", async () => {
    await renderTriggers(eight.slice(0, 6));

    expect(pages()).not.toBeInTheDocument();
  });

  it("draws its Create trigger and Trigger runs links, even with no triggers", async () => {
    await renderTriggers([]);

    expect(
      screen.getByRole("link", { name: /Create trigger/ }),
    ).toHaveAttribute("href", "/org1/workspace/ws1/triggers/create");
    expect(screen.getByRole("link", { name: /Trigger runs/ })).toHaveAttribute(
      "href",
      "/org1/workspace/ws1/trigger-runs",
    );
  });
});
