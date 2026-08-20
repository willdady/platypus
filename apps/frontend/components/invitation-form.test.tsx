import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "http://test",
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

// The form never has any Blueprints to offer in these tests.
vi.mock("swr", () => ({
  __esModule: true,
  default: () => ({ data: { results: [] }, isLoading: false }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

import { InvitationForm } from "./invitation-form";

// --- Helpers -----------------------------------------------------------------

function mockResponse(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);
}

function renderForm() {
  return render(<InvitationForm orgId="org1" />);
}

function submit() {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "user@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
}

// --- Tests -------------------------------------------------------------------

describe("InvitationForm conflict handling", () => {
  beforeEach(() => {
    toastError.mockReset();
    toastSuccess.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A duplicate invite is a 409 from the central error seam (ADR-0010),
  // carrying `{ error: "..." }` — the request module surfaces it as a
  // conflict outcome rather than the generic validation fallback.
  it("shows the backend's message against the Email field on a duplicate invite", async () => {
    vi.stubGlobal(
      "fetch",
      mockResponse(409, {
        error:
          "A pending invitation already exists for this user and organization",
      }),
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
    vi.stubGlobal(
      "fetch",
      mockResponse(400, { error: "You cannot invite yourself" }),
    );

    renderForm();
    submit();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("You cannot invite yourself"),
    );
  });

  it("clears the form and reports success once the invite is accepted", async () => {
    vi.stubGlobal("fetch", mockResponse(201, { id: "inv-1" }));

    renderForm();
    submit();

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Invitation created"),
    );
    expect(screen.getByLabelText("Email")).toHaveValue("");
  });
});
