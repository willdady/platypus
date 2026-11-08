import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { InvitationListItem } from "@platypus/schemas";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  mutate,
  navigationMock,
  stubAcceptedSave,
  stubRejectedSave,
  toastError,
  toastSuccess,
} from "@/test/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  ...navigationMock,
  useParams: () => ({ orgId: "org1" }),
}));

import OrgInvitationsPage from "./org-invitations";

const invitation = {
  id: "inv1",
  email: "sam@example.com",
  workspaceName: "Ops",
  status: "pending",
  expiresAt: new Date("2030-01-01").toISOString(),
} as unknown as InvitationListItem;

beforeEach(() => {
  resetListHarness();
  mockScopedSWR({ "/invitations": [invitation] });
});

async function confirmDelete() {
  await renderList(<OrgInvitationsPage />);
  fireEvent.click(
    screen.getByRole("button", {
      name: "Delete invitation for sam@example.com",
    }),
  );
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  return dialog;
}

describe("OrgInvitationsPage failed read", () => {
  it("shows a failed read as an error with a retry, not an empty table", async () => {
    mockScopedSWR({
      "/invitations": { error: { status: 500, message: "Server error" } },
      "/blueprints": [],
    });
    await renderList(<OrgInvitationsPage />);

    expect(
      screen.getByText("Failed to load invitations. Server error"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No invitations sent yet"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalled();
  });

  it("keeps showing cached rows when a revalidation fails", async () => {
    mockScopedSWR({
      "/invitations": {
        data: { results: [invitation] },
        error: { status: 500, message: "Server error" },
      },
      "/blueprints": [],
    });
    await renderList(<OrgInvitationsPage />);

    expect(screen.getByText("sam@example.com")).toBeInTheDocument();
    expect(
      screen.queryByText(/Failed to load invitations/),
    ).not.toBeInTheDocument();
  });

  it("keeps the invitation form usable while the list failed to read", async () => {
    mockScopedSWR({
      "/invitations": { error: { status: 500, message: "Server error" } },
      "/blueprints": [],
    });
    await renderList(<OrgInvitationsPage />);

    expect(screen.getByLabelText("Email")).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Send invitation" }),
    ).toBeInTheDocument();
  });
});

describe("OrgInvitationsPage empty list", () => {
  it("says no invitations have been sent yet", async () => {
    mockScopedSWR({ "/invitations": [], "/blueprints": [] });
    await renderList(<OrgInvitationsPage />);

    expect(screen.getByText("No invitations sent yet")).toBeInTheDocument();
  });
});

describe("OrgInvitationsPage delete", () => {
  it("deletes an invitation, says so and rereads the list", async () => {
    const fetchMock = stubAcceptedSave({});
    await confirmDelete();

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Invitation deleted"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/invitations/inv1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(mutate).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("keeps a refused delete in the dialog, with the backend's message", async () => {
    stubRejectedSave("Invitation already accepted", 409);
    const dialog = await confirmDelete();

    expect(
      await within(dialog).findByText("Invitation already accepted"),
    ).toBeVisible();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
