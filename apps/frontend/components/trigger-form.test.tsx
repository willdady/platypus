import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// --- Module mocks ------------------------------------------------------------

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "http://test",
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const agents = [{ id: "agent-1", name: "Agent One" }];

vi.mock("swr", () => ({
  __esModule: true,
  default: (key: string | null) => {
    if (key?.includes("/agents")) {
      return { data: { results: agents }, isLoading: false, mutate: vi.fn() };
    }
    if (key?.includes("/boards")) {
      return { data: { results: [] }, isLoading: false, mutate: vi.fn() };
    }
    return { data: undefined, isLoading: false, mutate: vi.fn() };
  },
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

import { TriggerForm } from "./trigger-form";

// --- Helpers -----------------------------------------------------------------

/** An accepted save, so the payload the form sent can be read back. */
function stubAcceptedSave() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ id: "trigger-1" }),
  } as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The `config` the form put on the wire for the last save. */
function savedConfig(fetchMock: ReturnType<typeof vi.fn>) {
  const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(String(init.body)).config;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function renderEventTriggerForm() {
  render(<TriggerForm orgId="org1" workspaceId="ws1" />);
  await waitFor(() => expect(screen.getByText("Agent")).toBeInTheDocument());

  // Trigger Type is a Radix Select defaulting to "Cron" — open it and pick
  // "Event" the same way provider-form's tests drive Radix Select controls.
  const triggerTypeSelect = screen
    .getAllByRole("combobox")
    .find((el) => el.textContent === "Cron")!;
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
  try {
    fireEvent.keyDown(triggerTypeSelect, { key: "ArrowDown" });
    const event = await screen.findByRole("option", { name: "Event" });
    fireEvent.keyDown(event, { key: "Enter" });
  } finally {
    Element.prototype.scrollIntoView = scrollIntoView;
  }
}

describe("TriggerForm — changed-fields filter", () => {
  it("hides the changed-fields filter until card.updated is selected", async () => {
    await renderEventTriggerForm();

    expect(screen.queryByText("Filter by Changed Fields")).toBeNull();

    fireEvent.click(screen.getByLabelText("card.updated"));

    expect(screen.getByText("Filter by Changed Fields")).toBeInTheDocument();
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
    const fetchMock = stubAcceptedSave();
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
