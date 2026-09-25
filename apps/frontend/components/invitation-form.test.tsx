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
  savedBody,
} from "@/lib/form-test-harness";
import { installResizeObserverStub } from "@/lib/test-utils";

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
    const fetchMock = stubAcceptedSave({ id: "inv-1" }, 201);

    renderForm();
    submit();

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Invitation created"),
    );
    expect(screen.getByLabelText("Email")).toHaveValue("");
    // A blank Workspace name and no Blueprints are left to the backend's
    // defaults rather than sent empty.
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://test/organizations/org1/invitations",
    );
    expect(savedBody(fetchMock)).toEqual({ email: "user@example.com" });
  });
});

describe("InvitationForm Blueprints", () => {
  // ADR-0009: Blueprints apply in the order listed, so the order the reader
  // arranged is the order that goes on the wire.
  it("sends the chosen Blueprints in the arranged order, with the trimmed Workspace name", async () => {
    setData({
      results: [
        { id: "b1", name: "Alpha" },
        { id: "b2", name: "Beta" },
      ],
    });
    const fetchMock = stubAcceptedSave({ id: "inv-1" }, 201);
    // Radix's Switch measures itself.
    installResizeObserverStub();
    renderForm();

    fireEvent.click(screen.getByRole("switch", { name: "Alpha" }));
    fireEvent.click(screen.getByRole("switch", { name: "Beta" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Move earlier" })[1]);
    fireEvent.change(screen.getByLabelText("Workspace name"), {
      target: { value: "  Team space  " },
    });
    submit();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedBody(fetchMock)).toEqual({
      email: "user@example.com",
      workspaceName: "Team space",
      blueprintIds: ["b2", "b1"],
    });
  });
});
