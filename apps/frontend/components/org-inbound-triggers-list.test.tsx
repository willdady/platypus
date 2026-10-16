import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  stubAcceptedSave,
  mutate,
} from "@/test/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { OrgInboundTriggersList } from "./org-inbound-triggers-list";

const row = (over: Record<string, unknown> = {}) => ({
  id: "trig-1",
  name: "Ready for AI",
  enabled: true,
  workspaceId: "ws-1",
  workspaceName: "Support",
  ownerId: "user-1",
  ownerName: "Dana Owner",
  createdAt: "2026-09-01T10:00:00.000Z",
  tokenStatus: "expiring",
  tokenCreatedAt: "2026-07-01T10:00:00.000Z",
  tokenExpiresAt: "2026-10-15T10:00:00.000Z",
  lastUsedAt: null,
  lastRejectedAt: "2026-09-28T10:00:00.000Z",
  ...over,
});

beforeEach(resetListHarness);

describe("OrgInboundTriggersList", () => {
  it("lists each Inbound Trigger with its Workspace, Owner and token standing", async () => {
    mockScopedSWR({ "/inbound-triggers": [row()] }, { strict: true });
    await renderList(<OrgInboundTriggersList orgId="org1" />);

    const [, dataRow] = screen.getAllByRole("row");
    expect(within(dataRow).getByText("Ready for AI")).toBeInTheDocument();
    expect(within(dataRow).getByText("Support")).toBeInTheDocument();
    expect(within(dataRow).getByText("Dana Owner")).toBeInTheDocument();
    expect(within(dataRow).getByText("Expiring soon")).toBeInTheDocument();
    expect(within(dataRow).getByText("Never")).toBeInTheDocument();
  });

  it("revokes the token the row showed through the Org route and revalidates", async () => {
    const fetchMock = stubAcceptedSave({ message: "Token revoked" });
    mockScopedSWR({ "/inbound-triggers": [row()] }, { strict: true });
    await renderList(<OrgInboundTriggersList orgId="org1" />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke token" }));
    const buttons = await screen.findAllByRole("button", {
      name: "Revoke token",
    });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/inbound-triggers/trig-1/token?tokenCreatedAt=2026-07-01T10%3A00%3A00.000Z",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("badges only a token that needs attention, not an active one", async () => {
    mockScopedSWR(
      { "/inbound-triggers": [row({ tokenStatus: "active" })] },
      { strict: true },
    );
    await renderList(<OrgInboundTriggersList orgId="org1" />);

    expect(
      screen.getByRole("columnheader", { name: "Expires" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
    // The expiry reads as a plain date, like the other date columns.
    expect(screen.queryByText(/Expires \d/)).not.toBeInTheDocument();
  });

  it("offers no revoke for a Trigger that has no token", async () => {
    mockScopedSWR(
      {
        "/inbound-triggers": [
          row({ tokenStatus: "none", tokenExpiresAt: null }),
        ],
      },
      { strict: true },
    );
    await renderList(<OrgInboundTriggersList orgId="org1" />);

    expect(screen.getByRole("button", { name: "Revoke token" })).toBeDisabled();
    expect(screen.getByText("No token")).toBeInTheDocument();
  });

  it("says so when no Workspace has one", async () => {
    mockScopedSWR({ "/inbound-triggers": [] }, { strict: true });
    await renderList(<OrgInboundTriggersList orgId="org1" />);

    expect(
      screen.getByText(
        /No workspace in this organization has an Inbound Trigger/,
      ),
    ).toBeInTheDocument();
  });
});
