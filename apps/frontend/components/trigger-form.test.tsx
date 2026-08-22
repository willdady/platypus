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
const boards = [{ id: "board-1", name: "Board One" }];

vi.mock("swr", () => ({
  __esModule: true,
  default: (key: string | null) => {
    if (key?.includes("/agents")) {
      return { data: { results: agents }, isLoading: false, mutate: vi.fn() };
    }
    if (key?.includes("/boards")) {
      return { data: { results: boards }, isLoading: false, mutate: vi.fn() };
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

/** Picks an option on the Radix Select currently reading `from`. */
async function selectOption(from: string, option: string) {
  const combobox = screen
    .getAllByRole("combobox")
    .find((el) => el.textContent === from)!;
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = vi.fn();
  try {
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    const item = await screen.findByRole("option", { name: option });
    fireEvent.keyDown(item, { key: "Enter" });
  } finally {
    Element.prototype.scrollIntoView = scrollIntoView;
  }
}

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
