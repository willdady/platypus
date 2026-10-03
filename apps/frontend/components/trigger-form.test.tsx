import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  navigationMock,
  authMock,
  toastMock,
  swrMock,
  setDataFor,
  setLoading,
  resetFormHarness,
  stubAcceptedSave,
  savedBody,
  push,
} from "@/lib/form-test-harness";
import { selectOption } from "@/lib/test-utils";

// --- Module mocks ------------------------------------------------------------

vi.mock("next/navigation", () => navigationMock);
vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { TriggerForm } from "./trigger-form";

// --- Helpers -----------------------------------------------------------------

const agents = [{ id: "agent-1", name: "Agent One" }];
const boards = [{ id: "board-1", name: "Board One" }];

/** The `config` the form put on the wire for the last save. */
function savedConfig(fetchMock: ReturnType<typeof vi.fn>) {
  return savedBody(fetchMock).config;
}

beforeEach(() => {
  resetFormHarness();
  setDataFor("/agents", { results: agents });
  setDataFor("/boards", { results: boards });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function renderEventTriggerForm() {
  render(<TriggerForm orgId="org1" workspaceId="ws1" />);
  await waitFor(() => expect(screen.getByText("Agent")).toBeInTheDocument());

  // Trigger Type is a Radix Select defaulting to "Cron".
  await selectOption("Cron", "Event");
}

describe("TriggerForm — board and column filters", () => {
  it("hides the column filter until a board is selected", async () => {
    await renderEventTriggerForm();

    fireEvent.click(screen.getByLabelText("card.updated"));

    expect(screen.queryByText("Only cards in this Column")).toBeNull();

    await selectOption("All boards", "Board One");

    expect(screen.getByText("Only cards in this Column")).toBeInTheDocument();
  });
});

describe("TriggerForm — changed-fields filter", () => {
  it("hides the changed-fields filter until card.updated is selected, and offers no Column in it", async () => {
    await renderEventTriggerForm();

    expect(
      screen.queryByText("Only when these fields change (card.updated)"),
    ).toBeNull();

    fireEvent.click(screen.getByLabelText("card.updated"));

    expect(
      screen.getByText("Only when these fields change (card.updated)"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Assignees")).toBeInTheDocument();
    // card.moved is the event for a Column change.
    expect(screen.queryByLabelText("Column")).toBeNull();
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
    expect(savedConfig(fetchMock)).toMatchObject({
      events: ["card.updated"],
      filters: { changedFields: ["assignees"] },
    });
  });
});

describe("TriggerForm — Include Memories", () => {
  it("keeps the control behind a collapsed Advanced settings panel and saves it off", async () => {
    const fetchMock = stubAcceptedSave({ id: "trigger-1" });
    render(<TriggerForm orgId="org1" workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText("Agent")).toBeInTheDocument());

    // Collapsed by default, so the switch isn't reachable yet.
    expect(screen.queryByLabelText(/Include Memories/)).toBeNull();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "My Trigger" },
    });
    fireEvent.change(screen.getByLabelText("Instruction"), {
      target: { value: "Do something" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedBody(fetchMock).includeMemories).toBe(false);
  });

  it("saves the opt-in once Advanced settings is expanded and the switch turned on", async () => {
    const fetchMock = stubAcceptedSave({ id: "trigger-1" });
    render(<TriggerForm orgId="org1" workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText("Agent")).toBeInTheDocument());

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
    expect(savedBody(fetchMock).includeMemories).toBe(true);
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
    expect(savedConfig(fetchMock)).toEqual({
      cronExpression,
      timezone: "UTC",
      isOneOff: false,
    });
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
    expect(savedBody(fetchMock)).toMatchObject({ type: "event", config });
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

describe("TriggerForm loading gate", () => {
  it("holds the form back until the boards land, so a saved filter isn't blank", () => {
    setLoading("/boards");

    render(<TriggerForm orgId="org1" workspaceId="ws1" />);

    expect(screen.getByLabelText("Loading trigger")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("TriggerForm — Inbound Triggers", () => {
  async function renderInboundTriggerForm() {
    render(<TriggerForm orgId="org1" workspaceId="ws1" />);
    await waitFor(() => expect(screen.getByText("Agent")).toBeInTheDocument());
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
    expect(savedBody(fetchMock)).toMatchObject({
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
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
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
    expect(savedConfig(fetchMock)).not.toHaveProperty("recordKey");
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
      hasToken: true,
      tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    const fetchMock = stubAcceptedSave({ id: "trigger-1" });
    render(
      <TriggerForm orgId="org1" workspaceId="ws1" triggerId="trigger-1" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedBody(fetchMock)).toMatchObject({
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
      hasToken: true,
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
});
