import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, act } from "@testing-library/react";
import type { InvitationListItem } from "@platypus/schemas";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  mutate,
} from "@/test/list-test-harness";
import { stubPendingSave } from "@/test/test-utils";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import UserInvitationsPage from "./page";

const invitation = {
  id: "inv1",
  organizationName: "Acme",
  invitedByName: "Bob",
  expiresAt: new Date("2030-01-01").toISOString(),
} as unknown as InvitationListItem;

beforeEach(resetListHarness);

describe("UserInvitationsPage accept", () => {
  it("sends one accept for a double click, disabled and labelled while pending", async () => {
    const { fetchMock, resolve } = stubPendingSave();
    mockScopedSWR({ "/invitations": [invitation] }, { strict: true });
    await renderList(<UserInvitationsPage />);

    const accept = screen.getByRole("button", { name: /Accept/ });
    fireEvent.click(accept);
    fireEvent.click(accept);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/users/me/invitations/inv1/accept",
      expect.objectContaining({ method: "POST" }),
    );
    expect(accept).toBeDisabled();
    expect(accept).toHaveTextContent("Accepting...");

    await act(async () => resolve());
    // The sidebar's Organization list picks up the new membership.
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith("http://test/organizations"),
    );
  });
});
