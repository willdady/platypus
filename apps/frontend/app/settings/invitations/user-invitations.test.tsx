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
  stubAcceptedSave,
  stubRejectedSave,
  toastError,
  toastSuccess,
} from "@/test/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import UserInvitationsPage from "./user-invitations";

const invitation = {
  id: "inv1",
  organizationName: "Acme",
  invitedByName: "Bob",
  expiresAt: new Date("2030-01-01").toISOString(),
} as unknown as InvitationListItem;

beforeEach(resetListHarness);

async function confirmDecline() {
  mockScopedSWR({ "/invitations": [invitation] }, { strict: true });
  await renderList(<UserInvitationsPage />);
  fireEvent.click(screen.getByRole("button", { name: /Decline/ }));
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Decline" }));
  return dialog;
}

describe("UserInvitationsPage", () => {
  it("lists each pending invitation with who sent it", async () => {
    mockScopedSWR({ "/invitations": [invitation] }, { strict: true });
    await renderList(<UserInvitationsPage />);

    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Invited by: Bob")).toBeInTheDocument();
  });

  it("says there is nothing pending when the list is empty", async () => {
    mockScopedSWR({ "/invitations": [] }, { strict: true });
    await renderList(<UserInvitationsPage />);

    expect(screen.getByText("No pending invitations")).toBeInTheDocument();
  });

  // A refused accept (expired, already used) must say why, not vanish.
  it("toasts the backend's message when an accept is refused", async () => {
    stubRejectedSave("Invitation has expired", 400);
    mockScopedSWR({ "/invitations": [invitation] }, { strict: true });
    await renderList(<UserInvitationsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Accept/ }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Invitation has expired"),
    );
    expect(mutate).not.toHaveBeenCalled();
  });

  it("declines after confirming, says so and rereads the list", async () => {
    const fetchMock = stubAcceptedSave({});
    await confirmDecline();

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Invitation declined"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/users/me/invitations/inv1/decline",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mutate).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  // The dialog keeps a refused decline so the reader can read it and retry.
  it("keeps a refused decline in the dialog, with the backend's message", async () => {
    stubRejectedSave("Invitation not found", 404);
    const dialog = await confirmDecline();

    expect(
      await within(dialog).findByText("Invitation not found"),
    ).toBeVisible();
    expect(mutate).not.toHaveBeenCalled();
  });
});
