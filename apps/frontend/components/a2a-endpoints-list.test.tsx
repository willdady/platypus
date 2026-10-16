import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  authMock,
  authState,
  swrMock,
  mockScopedSWR,
  mutate,
  resetListHarness,
  renderList,
  menuItemLabels,
  confirmDialog,
  stubAcceptedSave,
} from "@/test/list-test-harness";
import { openDropdownMenu } from "@/test/test-utils";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { A2aEndpointsList } from "./a2a-endpoints-list";

const asOwner = (owns: boolean) =>
  Object.assign(authState, { ownsWorkspace: owns });

const ENDPOINT = {
  id: "ep-1",
  agentId: "agent-1",
  agentName: "Helper",
  name: "Acme helpdesk",
  enabled: false,
  liveTokenCount: 1,
};

beforeEach(() => {
  resetListHarness();
  asOwner(true);
});

describe("A2aEndpointsList", () => {
  it("lists each endpoint with its agent, and lets the Owner add one", () => {
    mockScopedSWR({ "/a2a-endpoints": [ENDPOINT] }, { strict: true });
    renderList(<A2aEndpointsList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByRole("link", { name: /Acme helpdesk/ })).toHaveAttribute(
      "href",
      "/org1/workspace/ws1/settings/a2a-endpoints/ep-1",
    );
    expect(screen.getByText("Helper")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Add endpoint/ }),
    ).toBeInTheDocument();
  });

  it("flags an endpoint with no live tokens, beside Disabled", () => {
    mockScopedSWR(
      {
        "/a2a-endpoints": [
          { ...ENDPOINT, liveTokenCount: 0 },
          { ...ENDPOINT, id: "ep-2", name: "Working", enabled: true },
        ],
      },
      { strict: true },
    );
    renderList(<A2aEndpointsList orgId="org1" workspaceId="ws1" />);

    const flagged = screen.getByRole("link", { name: /Acme helpdesk/ });
    expect(flagged).toHaveTextContent("Disabled");
    expect(flagged).toHaveTextContent("No active tokens");
    expect(screen.getByRole("link", { name: /Working/ })).not.toHaveTextContent(
      "No active tokens",
    );
  });

  it("offers no Add endpoint to an Org Admin in another Owner's workspace", () => {
    asOwner(false);
    mockScopedSWR({ "/a2a-endpoints": [ENDPOINT] }, { strict: true });
    renderList(<A2aEndpointsList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText("Acme helpdesk")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Add endpoint/ }),
    ).not.toBeInTheDocument();
  });

  it("shows a skeleton while the endpoints load", () => {
    mockScopedSWR({ "/a2a-endpoints": { isLoading: true } }, { strict: true });
    renderList(<A2aEndpointsList orgId="org1" workspaceId="ws1" />);

    expect(
      screen.getByRole("status", { name: "Loading A2A endpoints" }),
    ).toBeInTheDocument();
  });

  it("says when there are no endpoints, and offers to add one", () => {
    mockScopedSWR({ "/a2a-endpoints": [] }, { strict: true });
    renderList(<A2aEndpointsList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText("No A2A endpoints configured")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Add endpoint/ }),
    ).toBeInTheDocument();
  });

  it("tells an Org Admin in another Owner's workspace only the workspace owner can add one", () => {
    asOwner(false);
    mockScopedSWR({ "/a2a-endpoints": [] }, { strict: true });
    renderList(<A2aEndpointsList orgId="org1" workspaceId="ws1" />);

    expect(
      screen.getByText(/Only the workspace owner can add one/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Add endpoint/ }),
    ).not.toBeInTheDocument();
  });

  it("shows a failed read as an error with a retry, not as no endpoints", () => {
    mockScopedSWR(
      {
        "/a2a-endpoints": { error: { status: 500, message: "Server error" } },
      },
      { strict: true },
    );
    renderList(<A2aEndpointsList orgId="org1" workspaceId="ws1" />);

    expect(
      screen.getByText("Failed to load A2A endpoints. Server error"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No A2A endpoints configured"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalled();
  });

  it("gives the Owner Edit, Enable, then Delete", () => {
    mockScopedSWR({ "/a2a-endpoints": [ENDPOINT] }, { strict: true });
    renderList(<A2aEndpointsList orgId="org1" workspaceId="ws1" />);
    openDropdownMenu();

    expect(menuItemLabels()).toEqual(["Edit", "Enable", "Delete"]);
  });

  it("gives anyone else only Edit, which opens the form read-only", () => {
    asOwner(false);
    mockScopedSWR({ "/a2a-endpoints": [ENDPOINT] }, { strict: true });
    renderList(<A2aEndpointsList orgId="org1" workspaceId="ws1" />);
    openDropdownMenu();

    expect(menuItemLabels()).toEqual(["Edit"]);
  });

  it("enables a disabled endpoint from the menu", async () => {
    const fetchMock = stubAcceptedSave();
    mockScopedSWR({ "/a2a-endpoints": [ENDPOINT] }, { strict: true });
    renderList(<A2aEndpointsList orgId="org1" workspaceId="ws1" />, "Enable");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/a2a-endpoints/ep-1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
      }),
    );
  });

  it("deletes after confirmation and revalidates", async () => {
    const fetchMock = stubAcceptedSave();
    mockScopedSWR({ "/a2a-endpoints": [ENDPOINT] }, { strict: true });
    renderList(<A2aEndpointsList orgId="org1" workspaceId="ws1" />, "Delete");

    expect(fetchMock).not.toHaveBeenCalled();
    await confirmDialog("Delete");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/a2a-endpoints/ep-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
