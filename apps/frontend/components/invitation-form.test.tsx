import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  authMock,
  toastMock,
  swrMock,
  toastError,
  toastSuccess,
  setData,
  resetFormHarness,
  stubAcceptedSave,
  stubRejectedSave,
} from "@/lib/form-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { InvitationForm } from "./invitation-form";

// --- Helpers -----------------------------------------------------------------

function renderForm() {
  return render(<InvitationForm orgId="org1" />);
}

function submit() {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "user@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
}

beforeEach(() => {
  resetFormHarness();
  // The form never has any Blueprints to offer in these tests.
  setData({ results: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("InvitationForm conflict handling", () => {
  // A duplicate invite is a 409 from the central error seam (ADR-0010),
  // carrying `{ error: "..." }` — the request module surfaces it as a
  // conflict outcome rather than the generic validation fallback.
  it("shows the backend's message against the Email field on a duplicate invite", async () => {
    stubRejectedSave(
      "A pending invitation already exists for this user and organization",
      409,
    );

    renderForm();
    submit();

    await waitFor(() =>
      expect(
        screen.getByText(
          "A pending invitation already exists for this user and organization",
        ),
      ).toBeInTheDocument(),
    );
  });

  it("never discards a rejection silently — a plain 400 message still surfaces", async () => {
    stubRejectedSave("You cannot invite yourself", 400);

    renderForm();
    submit();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("You cannot invite yourself"),
    );
  });

  it("clears the form and reports success once the invite is accepted", async () => {
    stubAcceptedSave({ id: "inv-1" }, 201);

    renderForm();
    submit();

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Invitation created"),
    );
    expect(screen.getByLabelText("Email")).toHaveValue("");
  });
});
