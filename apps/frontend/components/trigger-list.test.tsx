import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
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
  // The page around it owns the empty copy, so the list renders nothing at all
  // rather than a second, competing empty state.
  it("renders only the Show fired toggle when the workspace lists no triggers", () => {
    renderTriggers([]);

    expect(
      screen.getByRole("switch", { name: "Show fired" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
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
    expect(screen.getByText(/Called from outside/)).toBeInTheDocument();
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
