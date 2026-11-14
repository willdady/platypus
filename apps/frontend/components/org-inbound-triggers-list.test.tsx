import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  stubAcceptedSave,
  stubRejectedSave,
  mutate,
  toastError,
  menuItemLabels,
  openRowMenu,
  chooseRowMenuAction,
} from "@/test/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { OrgInboundTriggersList } from "./org-inbound-triggers-list";

function row(over: Record<string, unknown> = {}) {
  return {
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
  };
}

beforeEach(resetListHarness);

/** Opens the row's ⋮ menu, picks Revoke token, then confirms the dialog. */
async function revoke() {
  await chooseRowMenuAction("Ready for AI", "Revoke token");
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Revoke token" }));
}

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

  it("badges a disabled Trigger with the shared Disabled badge", async () => {
    mockScopedSWR(
      { "/inbound-triggers": [row({ enabled: false })] },
      { strict: true },
    );
    await renderList(<OrgInboundTriggersList orgId="org1" />);

    const [, dataRow] = screen.getAllByRole("row");
    const badge = within(dataRow).getByText("Disabled");
    // The badge's Pause icon is decorative, so no accessible query sees it.
    // eslint-disable-next-line testing-library/no-node-access
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("puts Revoke token in the row's ⋮ menu, destructive", async () => {
    mockScopedSWR({ "/inbound-triggers": [row()] }, { strict: true });
    await renderList(<OrgInboundTriggersList orgId="org1" />);
    await openRowMenu("Ready for AI");

    expect(menuItemLabels()).toEqual(["Revoke token"]);
    expect(
      screen.getByRole("menuitem", { name: "Revoke token" }),
    ).toHaveAttribute("data-variant", "destructive");
  });

  it("revokes the token the row showed through the Org route and revalidates", async () => {
    const fetchMock = stubAcceptedSave({ message: "Token revoked" });
    mockScopedSWR({ "/inbound-triggers": [row()] }, { strict: true });
    await renderList(<OrgInboundTriggersList orgId="org1" />);

    await revoke();

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/inbound-triggers/trig-1/token?tokenCreatedAt=2026-07-01T10%3A00%3A00.000Z",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("guards with the row's creation time as one serialised instant", async () => {
    const fetchMock = stubAcceptedSave({ message: "Token revoked" });
    mockScopedSWR(
      {
        "/inbound-triggers": [
          row({ tokenCreatedAt: "2026-07-01T12:00:00+02:00" }),
        ],
      },
      { strict: true },
    );
    await renderList(<OrgInboundTriggersList orgId="org1" />);

    await revoke();

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/inbound-triggers/trig-1/token?tokenCreatedAt=2026-07-01T10%3A00%3A00.000Z",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("keeps a refused revoke in the dialog and still revalidates", async () => {
    stubRejectedSave("A newer token was issued since this list loaded", 409);
    mockScopedSWR({ "/inbound-triggers": [row()] }, { strict: true });
    await renderList(<OrgInboundTriggersList orgId="org1" />);

    await revoke();

    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(
        "A newer token was issued since this list loaded",
      ),
    ).toBeVisible();
    expect(toastError).not.toHaveBeenCalled();
    await waitFor(() => expect(mutate).toHaveBeenCalled());
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

  it("offers a disabled Revoke token for a Trigger that has no token", async () => {
    mockScopedSWR(
      {
        "/inbound-triggers": [
          row({ tokenStatus: "none", tokenExpiresAt: null }),
        ],
      },
      { strict: true },
    );
    await renderList(<OrgInboundTriggersList orgId="org1" />);
    await openRowMenu("Ready for AI");

    expect(
      screen.getByRole("menuitem", { name: "Revoke token" }),
    ).toHaveAttribute("data-disabled");
    expect(screen.getByText("No token")).toBeInTheDocument();
  });

  it("says so when no Workspace has one", async () => {
    mockScopedSWR({ "/inbound-triggers": [] }, { strict: true });
    await renderList(<OrgInboundTriggersList orgId="org1" />);

    expect(screen.getByText("No inbound triggers yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        /No workspace in this organization has an Inbound Trigger/,
      ),
    ).toBeInTheDocument();
  });
});
