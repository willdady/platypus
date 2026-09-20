import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  navigationMock,
  authMock,
  toastMock,
  swrMock,
  setDataFor,
  resetFormHarness,
  stubAcceptedSave,
  savedBody,
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
  it("hides the changed-fields filter until card.updated is selected", async () => {
    await renderEventTriggerForm();

    expect(
      screen.queryByText("Only when these fields change (card.updated)"),
    ).toBeNull();

    fireEvent.click(screen.getByLabelText("card.updated"));

    expect(
      screen.getByText("Only when these fields change (card.updated)"),
    ).toBeInTheDocument();
  });

  it("does not offer Column as a changed field — card.moved is that event", async () => {
    await renderEventTriggerForm();

    fireEvent.click(screen.getByLabelText("card.updated"));

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
