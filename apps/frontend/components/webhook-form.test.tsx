import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  navigationMock,
  configMock,
  authMock,
  toastMock,
  swrMock,
  push,
  resetFormHarness,
  jsonResponse,
  stubRejectedSave,
} from "@/lib/form-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("next/navigation", () => navigationMock);
vi.mock("@/app/client-context", () => configMock);
vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
// The create form never keys a fetch off a webhook id, so SWR never loads
// real data here — the harness's default (unset) response is `undefined`.
vi.mock("swr", () => swrMock);

import { WebhookForm } from "./webhook-form";

// --- Helpers -----------------------------------------------------------------

function renderForm() {
  return render(<WebhookForm orgId="org1" workspaceId="ws1" />);
}

// --- Tests -------------------------------------------------------------------

describe("WebhookForm validation error surfacing", () => {
  beforeEach(() => {
    resetFormHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves, shows the rejected events error, then saves again once corrected", async () => {
    const fetchMock = stubRejectedSave([
      { path: ["events"], message: "At least one event is required" },
    ]);

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
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    fireEvent.click(saveButton);

    await waitFor(() => expect(push).toHaveBeenCalled());
  });

  it("clears the enabled field's error when the switch is toggled", async () => {
    stubRejectedSave([{ path: ["enabled"], message: "Invalid enabled" }]);

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
    stubRejectedSave([
      { path: ["headers", "X-Foo"], message: "Header value is too long" },
    ]);

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
