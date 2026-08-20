import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

// The create form never keys a fetch off a webhook id, so SWR never loads
// real data here.
vi.mock("swr", () => ({
  __esModule: true,
  default: () => ({ data: undefined, isLoading: false, mutate: vi.fn() }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

import { WebhookForm } from "./webhook-form";

// --- Helpers -----------------------------------------------------------------

function mockFailedSave(error: unknown, status = 400) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ error }),
  } as unknown as Response);
}

function renderForm() {
  return render(<WebhookForm orgId="org1" workspaceId="ws1" />);
}

// --- Tests -------------------------------------------------------------------

describe("WebhookForm validation error surfacing", () => {
  beforeEach(() => {
    push.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves, shows the rejected events error, then saves again once corrected", async () => {
    const fetchMock = mockFailedSave([
      { path: ["events"], message: "At least one event is required" },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    renderForm();

    const saveButton = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(
        screen.getByText("At least one event is required"),
      ).toBeInTheDocument(),
    );
    // A shown error disables Save until the offending field is corrected.
    expect(saveButton).toBeDisabled();

    // Toggling any event is an edit to the events field — it retracts the
    // error and re-enables Save, without needing a page reload.
    fireEvent.click(
      screen.getByRole("switch", { name: "Notification created" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByText("At least one event is required"),
      ).not.toBeInTheDocument(),
    );
    expect(saveButton).not.toBeDisabled();

    // The round trip completes: re-submitting now succeeds.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as unknown as Response);
    fireEvent.click(saveButton);

    await waitFor(() => expect(push).toHaveBeenCalled());
  });

  it("clears the enabled field's error when the switch is toggled", async () => {
    vi.stubGlobal(
      "fetch",
      mockFailedSave([{ path: ["enabled"], message: "Invalid enabled" }]),
    );

    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByText("Invalid enabled")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));

    await waitFor(() =>
      expect(screen.queryByText("Invalid enabled")).not.toBeInTheDocument(),
    );
  });

  it("retracts a row-level headers error only when that row is edited", async () => {
    vi.stubGlobal(
      "fetch",
      mockFailedSave([
        { path: ["headers", "X-Foo"], message: "Header value is too long" },
      ]),
    );

    renderForm();

    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    fireEvent.change(screen.getByPlaceholderText("Header name"), {
      target: { value: "X-Foo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    const values = screen.getAllByPlaceholderText("Header value");
    fireEvent.change(values[0], { target: { value: "bar" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByText("Header value is too long")).toBeInTheDocument(),
    );

    // Editing the unrelated second row must not strand or clear the first
    // row's error.
    const names = screen.getAllByPlaceholderText("Header name");
    fireEvent.change(names[1], { target: { value: "X-Bar" } });
    expect(screen.getByText("Header value is too long")).toBeInTheDocument();

    // Editing the offending row retracts its own error.
    fireEvent.change(names[0], { target: { value: "X-Foo-Fixed" } });
    await waitFor(() =>
      expect(
        screen.queryByText("Header value is too long"),
      ).not.toBeInTheDocument(),
    );
  });
});
