import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import {
  authMock,
  swrMock,
  setDataFor,
  setLoading,
  resetFormHarness,
  authState,
  setupUser,
  stubAcceptedSave,
  stubRejectedSave,
  push,
  toastError,
  toastSuccess,
} from "@/test/form-test-harness";
import { triggerCreateSchema, triggerUpdateSchema } from "@platypus/schemas";
import { expectSentBodyToMatchSchema, selectOption } from "@/test/test-utils";
import { getBrowserTimezone } from "@/lib/timezones";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);
// The real list is every IANA zone (~420); opening the Timezone select renders
// all of them, which pushed a two-pick test past the 5s timeout on CI. These
// are the only zones the suite picks, plus the browser's own.
vi.mock("@/lib/timezones", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/timezones")>();
  return {
    ...actual,
    TIMEZONES: [
      ...new Set([
        "UTC",
        "Asia/Tokyo",
        "Pacific/Chatham",
        actual.getBrowserTimezone(),
      ]),
    ],
  };
});

import { TriggerForm } from "./trigger-form";

// --- Helpers -----------------------------------------------------------------

const agents = [{ id: "agent-1", name: "Agent One" }];
const boards = [{ id: "board-1", name: "Board One" }];

/** The create body the form put on the wire, checked against the strict schema. */
function savedCreateBody(fetchMock: ReturnType<typeof vi.fn>) {
  return expectSentBodyToMatchSchema(fetchMock, triggerCreateSchema);
}

/** The update body the form put on the wire, checked against the strict schema. */
function savedUpdateBody(fetchMock: ReturnType<typeof vi.fn>) {
  return expectSentBodyToMatchSchema(fetchMock, triggerUpdateSchema);
}

beforeEach(() => {
  resetFormHarness();
  setDataFor("/agents", { results: agents });
  setDataFor("/boards", { results: boards });
});

async function renderEventTriggerForm() {
  render(<TriggerForm orgId="org1" workspaceId="ws1" />);
  expect(await screen.findByText("Agent")).toBeInTheDocument();

  // Trigger Type is a Radix Select defaulting to "Cron".
  await selectOption("Cron", "Event");
}

describe("TriggerForm — form submission", () => {
  it("saves on Enter in the Name field", async () => {
    const fetchMock = stubAcceptedSave({ id: "t1" });
    render(<TriggerForm orgId="org1" workspaceId="ws1" />);
    expect(await screen.findByText("Agent")).toBeInTheDocument();

    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "Nightly" } });
    fireEvent.change(screen.getByLabelText("Instruction"), {
      target: { value: "Do it" },
    });
    await setupUser().type(name, "{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(savedCreateBody(fetchMock)).toMatchObject({ name: "Nightly" });
  });

  it("opens Advanced settings without saving the Trigger", async () => {
    const fetchMock = stubAcceptedSave({ id: "t1" });
    render(<TriggerForm orgId="org1" workspaceId="ws1" />);
    expect(await screen.findByText("Agent")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));

    expect(screen.getByLabelText(/Include Memories/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// #1845: every save and delete toasts success, including those that navigate
// away.
describe("TriggerForm — success feedback", () => {
  it("toasts that the Trigger was created", async () => {
    stubAcceptedSave({ id: "t1" });
    render(<TriggerForm orgId="org1" workspaceId="ws1" />);
    expect(await screen.findByText("Agent")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Nightly" },
    });
    fireEvent.change(screen.getByLabelText("Instruction"), {
      target: { value: "Do it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Trigger created"),
    );
    expect(push).toHaveBeenCalledWith("/org1/workspace/ws1");
  });

  it("toasts that the Trigger was updated", async () => {
    setDataFor("/triggers/trigger-1", {
      id: "trigger-1",
      workspaceId: "ws1",
      agentId: "agent-1",
      name: "Nightly",
      instruction: "Do it",
      type: "cron",
      config: {
        cronExpression: "30 9 * * *",
        timezone: "UTC",
        isOneOff: false,
      },
      enabled: true,
      maxRunsToKeep: 10,
    });
    stubAcceptedSave({ id: "trigger-1" });
    render(
      <TriggerForm orgId="org1" workspaceId="ws1" triggerId="trigger-1" />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Update" }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Trigger updated"),
    );
  });

  it("toasts that the Trigger was deleted", async () => {
    setDataFor("/triggers/trigger-1", {
      id: "trigger-1",
      workspaceId: "ws1",
      agentId: "agent-1",
      name: "Nightly",
      instruction: "Do it",
      type: "cron",
      config: {
        cronExpression: "30 9 * * *",
        timezone: "UTC",
        isOneOff: false,
      },
      enabled: true,
      maxRunsToKeep: 10,
    });
    stubAcceptedSave({});
    render(
      <TriggerForm orgId="org1" workspaceId="ws1" triggerId="trigger-1" />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Delete/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Trigger deleted"),
    );
    expect(push).toHaveBeenCalledWith("/org1/workspace/ws1");
  });
});

describe("TriggerForm — event picker", () => {
  it("offers no Trigger run events, which only a Webhook can subscribe to", async () => {
    await renderEventTriggerForm();

    expect(screen.getByLabelText("card.updated")).toBeInTheDocument();
    expect(screen.queryByText("Trigger runs")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("trigger_run.failed"),
    ).not.toBeInTheDocument();
  });
});

describe("TriggerForm — switching type", () => {
  it("keeps what was entered under a type when the user switches away and back", async () => {
    await renderEventTriggerForm();
    fireEvent.click(screen.getByLabelText("card.updated"));

    await selectOption("Event", "Cron");
    await selectOption("Cron", "Event");

    expect(screen.getByLabelText("card.updated")).toBeChecked();
  });
});

describe("TriggerForm — board and column filters", () => {
  it("hides the column filter until a board is selected", async () => {
    await renderEventTriggerForm();

    fireEvent.click(screen.getByLabelText("card.updated"));

    expect(
      screen.queryByText("Only cards in this Column"),
    ).not.toBeInTheDocument();

    await selectOption("All boards", "Board One");

    expect(screen.getByText("Only cards in this Column")).toBeInTheDocument();
  });
});

describe("TriggerForm — changed-fields filter", () => {
  it("hides the changed-fields filter until card.updated is selected, and offers no Column in it", async () => {
    await renderEventTriggerForm();

    expect(
      screen.queryByText("Only when these fields change (card.updated)"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("card.updated"));

    expect(
      screen.getByText("Only when these fields change (card.updated)"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Assignees")).toBeInTheDocument();
    // card.moved is the event for a Column change.
    expect(screen.queryByLabelText("Column")).not.toBeInTheDocument();
  });

  it("clears the changed-fields filter when card.updated is deselected", async () => {
    await renderEventTriggerForm();

    fireEvent.click(screen.getByLabelText("card.updated"));
    fireEvent.click(screen.getByLabelText("Assignees"));
    fireEvent.click(screen.getByLabelText("card.updated"));
    fireEvent.click(screen.getByLabelText("card.updated"));

    expect(screen.getByLabelText("Assignees")).not.toBeChecked();
  });

  it("submits the selected changed fields as the trigger filter", async () => {
    const fetchMock = stubAcceptedSave({ id: "trigger-1" });
    await renderEventTriggerForm();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "My Trigger" },
    });
    fireEvent.change(screen.getByLabelText("Instruction"), {
      target: { value: "Do something" },
    });
    fireEvent.click(screen.getByLabelText("card.updated"));
    fireEvent.click(screen.getByLabelText("Assignees"));

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedCreateBody(fetchMock).config).toMatchObject({
      events: ["card.updated"],
      filters: { changedFields: ["assignees"] },
    });
  });
});

describe("TriggerForm — Include Memories", () => {
  it("keeps the control behind a collapsed Advanced settings panel and saves it off", async () => {
    const fetchMock = stubAcceptedSave({ id: "trigger-1" });
    render(<TriggerForm orgId="org1" workspaceId="ws1" />);
    expect(await screen.findByText("Agent")).toBeInTheDocument();

    // Collapsed by default, so the switch isn't reachable yet.
    expect(screen.queryByLabelText(/Include Memories/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "My Trigger" },
    });
    fireEvent.change(screen.getByLabelText("Instruction"), {
      target: { value: "Do something" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedCreateBody(fetchMock).includeMemories).toBe(false);
  });

  it("saves the opt-in once Advanced settings is expanded and the switch turned on", async () => {
    const fetchMock = stubAcceptedSave({ id: "trigger-1" });
    render(<TriggerForm orgId="org1" workspaceId="ws1" />);
    expect(await screen.findByText("Agent")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Advanced settings"));
    fireEvent.click(screen.getByLabelText(/Include Memories/));

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "My Trigger" },
    });
    fireEvent.change(screen.getByLabelText("Instruction"), {
      target: { value: "Do something" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedCreateBody(fetchMock).includeMemories).toBe(true);
  });
});

describe("TriggerForm — Extract Memories", () => {
  it("saves it off by default, and on once Advanced settings is expanded and the switch turned on", async () => {
    const fetchMock = stubAcceptedSave({ id: "trigger-1" });
    render(<TriggerForm orgId="org1" workspaceId="ws1" />);
    expect(await screen.findByText("Agent")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Extract Memories/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Advanced settings"));
    fireEvent.click(screen.getByLabelText(/Extract Memories/));

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "My Trigger" },
    });
    fireEvent.change(screen.getByLabelText("Instruction"), {
      target: { value: "Do something" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedCreateBody(fetchMock).extractMemories).toBe(true);
    expect(savedCreateBody(fetchMock).includeMemories).toBe(false);
  });
});

describe("TriggerForm — default timezone", () => {
  it("moves a new Trigger onto the User timezone when the session lands after mount", async () => {
    const fetchMock = stubAcceptedSave({ id: "trigger-1" });
    authState.user = null;
    const { rerender } = render(<TriggerForm orgId="org1" workspaceId="ws1" />);
    expect(await screen.findByText("Agent")).toBeInTheDocument();

    authState.user = { id: "u1", timezone: "Pacific/Chatham" };
    rerender(<TriggerForm orgId="org1" workspaceId="ws1" />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "My Trigger" },
    });
    fireEvent.change(screen.getByLabelText("Instruction"), {
      target: { value: "Do something" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedCreateBody(fetchMock).config).toMatchObject({
      timezone: "Pacific/Chatham",
    });
  });

  it("keeps a browser zone the User picked before the session lands", async () => {
    const fetchMock = stubAcceptedSave({ id: "trigger-1" });
    authState.user = null;
    const browserZone = getBrowserTimezone();
    const otherZone = browserZone === "UTC" ? "Asia/Tokyo" : "UTC";
    const { rerender } = render(<TriggerForm orgId="org1" workspaceId="ws1" />);
    expect(await screen.findByText("Agent")).toBeInTheDocument();

    // Radix only reports a change, so pick the browser zone back deliberately.
    await selectOption(browserZone, otherZone);
    await selectOption(otherZone, browserZone);

    authState.user = { id: "u1", timezone: "Pacific/Chatham" };
    rerender(<TriggerForm orgId="org1" workspaceId="ws1" />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "My Trigger" },
    });
    fireEvent.change(screen.getByLabelText("Instruction"), {
      target: { value: "Do something" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedCreateBody(fetchMock).config).toMatchObject({
      timezone: browserZone,
    });
  });
});

describe("TriggerForm — editing a saved trigger", () => {
  const saved = (config: unknown, type = "cron") => ({
    id: "trigger-1",
    workspaceId: "ws1",
    agentId: "agent-1",
    name: "Nightly",
    instruction: "Do it",
    type,
    config,
    enabled: true,
    maxRunsToKeep: 10,
  });

  const update = () =>
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

  // A saved schedule is read back into the simple editor where it fits one of
  // its frequencies, and left as a raw expression where it doesn't; either
  // way an untouched save must send the same schedule back.
  it.each([
    "*/15 * * * *",
    "5 * * * *",
    "30 9 * * *",
    "30 9 * * 1",
    "30 9 15 * *",
    "0 9 1-5 * *",
  ])("sends %s back unchanged", async (cronExpression) => {
    setDataFor(
      "/triggers/trigger-1",
      saved({ cronExpression, timezone: "UTC", isOneOff: false }),
    );
    const fetchMock = stubAcceptedSave({ id: "trigger-1" });
    render(
      <TriggerForm orgId="org1" workspaceId="ws1" triggerId="trigger-1" />,
    );

    update();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedUpdateBody(fetchMock).config).toEqual({
      cronExpression,
      timezone: "UTC",
      isOneOff: false,
    });
  });

  it("locks a fired One-off Trigger's schedule and Enabled, and says why", () => {
    setDataFor("/triggers/trigger-1", {
      ...saved({
        cronExpression: "30 9 * * *",
        timezone: "UTC",
        isOneOff: true,
      }),
      enabled: false,
      firedAt: "2026-01-02T09:30:00.000Z",
    });
    render(
      <TriggerForm orgId="org1" workspaceId="ws1" triggerId="trigger-1" />,
    );

    expect(
      screen.getByText(/This One-off Trigger has fired/),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Enabled/ })).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: /One-off Trigger/ }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Advanced" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Name" })).toBeEnabled();
  });

  it("seeds an event trigger's events and filters, and sends them back", async () => {
    const config = {
      events: ["card.updated"],
      filters: {
        boardId: "board-1",
        columnId: "col-1",
        changedFields: ["assignees"],
      },
    };
    setDataFor("/triggers/trigger-1", saved(config, "event"));
    const fetchMock = stubAcceptedSave({ id: "trigger-1" });
    render(
      <TriggerForm orgId="org1" workspaceId="ws1" triggerId="trigger-1" />,
    );

    expect(screen.getByLabelText("card.updated")).toBeChecked();
    expect(screen.getByLabelText("Assignees")).toBeChecked();
    update();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedUpdateBody(fetchMock)).toMatchObject({ type: "event", config });
  });
});

describe("TriggerForm — record revalidation", () => {
  it("keeps an unsaved edit when the scheduler bumps nextRunAt", () => {
    const trigger = {
      id: "trigger-1",
      workspaceId: "ws1",
      agentId: "agent-1",
      name: "Nightly",
      description: "Old",
      instruction: "Do it",
      type: "cron",
      config: { cronExpression: "0 9 * * *", timezone: "UTC", isOneOff: false },
      enabled: true,
      maxRunsToKeep: 10,
      nextRunAt: "2026-09-23T09:00:00.000Z",
    };
    setDataFor("/triggers/trigger-1", trigger);
    const { rerender } = render(
      <TriggerForm orgId="org1" workspaceId="ws1" triggerId="trigger-1" />,
    );

    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Edited" },
    });
    // A focus revalidation after the scheduler ran: same row, later schedule.
    setDataFor("/triggers/trigger-1", {
      ...trigger,
      lastRunAt: "2026-09-23T09:00:00.000Z",
      nextRunAt: "2026-09-24T09:00:00.000Z",
    });
    rerender(
      <TriggerForm orgId="org1" workspaceId="ws1" triggerId="trigger-1" />,
    );

    expect(screen.getByLabelText("Description")).toHaveValue("Edited");
  });
});

describe("TriggerForm — default agent", () => {
  const twoAgents = [
    { id: "agent-1", name: "Agent One" },
    { id: "agent-2", name: "Agent Two" },
  ];

  it("keeps the picked agent when the agent list revalidates", async () => {
    setDataFor("/agents", { results: twoAgents });
    const { rerender } = render(<TriggerForm orgId="org1" workspaceId="ws1" />);
    expect(await screen.findByText("Agent")).toBeInTheDocument();

    await selectOption("Agent One", "Agent Two");
    setDataFor("/agents", { results: twoAgents.map((a) => ({ ...a })) });
    rerender(<TriggerForm orgId="org1" workspaceId="ws1" />);

    expect(screen.getByRole("combobox", { name: "Agent" })).toHaveTextContent(
      "Agent Two",
    );
    expect(
      screen.getByRole("combobox", { name: "Agent" }),
    ).not.toHaveTextContent("Agent One");
  });

  it("saves the first agent when the user picks none", async () => {
    const fetchMock = stubAcceptedSave({ id: "t1" });
    render(<TriggerForm orgId="org1" workspaceId="ws1" />);
    expect(await screen.findByText("Agent")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Nightly" },
    });
    fireEvent.change(screen.getByLabelText("Instruction"), {
      target: { value: "Do it" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedCreateBody(fetchMock).agentId).toBe("agent-1");
  });
});

describe("TriggerForm loading gate", () => {
  it("holds the form back until the boards land, so a saved filter isn't blank", () => {
    setLoading("/boards");

    render(<TriggerForm orgId="org1" workspaceId="ws1" />);

    expect(screen.getByLabelText("Loading trigger")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  });
});

describe("TriggerForm — Inbound Triggers", () => {
  async function renderInboundTriggerForm() {
    render(<TriggerForm orgId="org1" workspaceId="ws1" />);
    expect(await screen.findByText("Agent")).toBeInTheDocument();
    await selectOption("Cron", "Inbound");
  }

  const fillBasics = () => {
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Ready for AI" },
    });
    fireEvent.change(screen.getByLabelText("Instruction"), {
      target: { value: "Work the issue" },
    });
  };

  it("saves declared inputs and a record key, then shows the token once before leaving", async () => {
    const fetchMock = stubAcceptedSave({
      id: "trigger-9",
      token: "pit_shown-once",
      tokenExpiresAt: "2026-12-28T12:00:00.000Z",
    });
    await renderInboundTriggerForm();
    fillBasics();

    fireEvent.click(screen.getByRole("button", { name: /add input/i }));
    fireEvent.change(screen.getByLabelText("Input 1 name"), {
      target: { value: "issueKey" },
    });
    fireEvent.change(screen.getByLabelText("Input 1 description"), {
      target: { value: "The tracker's issue key" },
    });
    await selectOption("None", "issueKey");
    await selectOption("90 days", "30 days");

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedCreateBody(fetchMock)).toMatchObject({
      type: "inbound",
      config: {
        inputs: [
          {
            name: "issueKey",
            required: true,
            description: "The tracker's issue key",
          },
        ],
        recordKey: "issueKey",
        tokenExpiryDays: 30,
      },
    });
    expect(await screen.findByDisplayValue("pit_shown-once")).toBeVisible();
    expect(
      screen.getByDisplayValue("http://test/hooks/triggers/trigger-9"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Test with curl")).toHaveValue(
      [
        "curl -X POST 'http://test/hooks/triggers/trigger-9' \\",
        "  -H 'Authorization: Bearer pit_shown-once' \\",
        "  -H 'Content-Type: application/json' \\",
        `  -d '{"inputs":{"issueKey":"<issueKey>"}}'`,
      ].join("\n"),
    );
    expect(push).not.toHaveBeenCalled();

    // Only the button closes it: Escape does not, and there is no corner X.
    fireEvent.keyDown(screen.getByDisplayValue("pit_shown-once"), {
      key: "Escape",
    });
    expect(screen.getByDisplayValue("pit_shown-once")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /copied it/i }));
    expect(push).toHaveBeenCalledWith("/org1/workspace/ws1");
  });

  it("does not claim the gate is closed while the Workspace is still loading", async () => {
    // Under `selected` the answer is the Workspace's own flag: unknown until
    // it loads, and unknown is not "not allowed".
    setDataFor("/organizations/org1", { inboundTriggerGate: "selected" });
    setLoading("/workspaces/ws1");
    await renderInboundTriggerForm();

    expect(
      screen.queryByText(/doesn.t allow Inbound Triggers/),
    ).not.toBeInTheDocument();
  });

  it("says the gate is closed and hides the fields once the Workspace has loaded without the allow flag", async () => {
    setDataFor("/organizations/org1", { inboundTriggerGate: "selected" });
    setDataFor("/workspaces/ws1", { inboundTriggersAllowed: false });
    await renderInboundTriggerForm();

    expect(
      screen.getByText(/doesn.t allow Inbound Triggers/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("unmarks the record key when its input stops being required", async () => {
    const fetchMock = stubAcceptedSave({ id: "trigger-9" });
    await renderInboundTriggerForm();
    fillBasics();

    fireEvent.click(screen.getByRole("button", { name: /add input/i }));
    fireEvent.change(screen.getByLabelText("Input 1 name"), {
      target: { value: "issueKey" },
    });
    await selectOption("None", "issueKey");
    fireEvent.click(screen.getByLabelText("Required"));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedCreateBody(fetchMock).config).not.toHaveProperty("recordKey");
  });

  it("holds the save back while an input name is invalid", async () => {
    await renderInboundTriggerForm();
    fillBasics();

    fireEvent.click(screen.getByRole("button", { name: /add input/i }));
    fireEvent.change(screen.getByLabelText("Input 1 name"), {
      target: { value: "issue-key" },
    });

    expect(screen.getByText(/is not a valid input name/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("sends an edited Inbound Trigger back as inbound, not as an event trigger", async () => {
    setDataFor("/triggers/trigger-1", {
      id: "trigger-1",
      workspaceId: "ws1",
      agentId: "agent-1",
      name: "Ready for AI",
      instruction: "Work the issue",
      type: "inbound",
      config: {
        inputs: [{ name: "issueKey", required: true }],
        recordKey: "issueKey",
        tokenExpiryDays: 90,
      },
      enabled: true,
      maxRunsToKeep: 10,
      tokenStatus: "active",
      tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    const fetchMock = stubAcceptedSave({ id: "trigger-1" });
    render(
      <TriggerForm orgId="org1" workspaceId="ws1" triggerId="trigger-1" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedUpdateBody(fetchMock)).toMatchObject({
      type: "inbound",
      config: {
        inputs: [{ name: "issueKey", required: true }],
        recordKey: "issueKey",
        tokenExpiryDays: 90,
      },
    });
  });

  it("regenerates the token and shows the new one once", async () => {
    setDataFor("/triggers/trigger-1", {
      id: "trigger-1",
      workspaceId: "ws1",
      agentId: "agent-1",
      name: "Ready for AI",
      instruction: "Work the issue",
      type: "inbound",
      config: { inputs: [], tokenExpiryDays: 90 },
      enabled: true,
      maxRunsToKeep: 10,
      tokenStatus: "active",
      tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    const fetchMock = stubAcceptedSave({
      token: "pit_regenerated",
      tokenExpiresAt: "2099-04-01T00:00:00.000Z",
    });
    render(
      <TriggerForm orgId="org1" workspaceId="ws1" triggerId="trigger-1" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    const confirm = await screen.findAllByRole("button", {
      name: "Regenerate",
    });
    fireEvent.click(confirm[confirm.length - 1]);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "http://test/organizations/org1/workspaces/ws1/triggers/trigger-1/token",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByDisplayValue("pit_regenerated")).toBeVisible();
  });

  it("keeps a refused token regenerate in the dialog with the backend's message", async () => {
    setDataFor("/triggers/trigger-1", {
      id: "trigger-1",
      workspaceId: "ws1",
      agentId: "agent-1",
      name: "Ready for AI",
      instruction: "Work the issue",
      type: "inbound",
      config: { inputs: [], tokenExpiryDays: 90 },
      enabled: true,
      maxRunsToKeep: 10,
      tokenStatus: "active",
      tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    stubRejectedSave("Token was revoked by an Org Admin", 409);
    render(
      <TriggerForm orgId="org1" workspaceId="ws1" triggerId="trigger-1" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    const confirm = await screen.findAllByRole("button", {
      name: "Regenerate",
    });
    fireEvent.click(confirm[confirm.length - 1]);

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("Token was revoked by an Org Admin"),
    ).toBeVisible();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });
});
