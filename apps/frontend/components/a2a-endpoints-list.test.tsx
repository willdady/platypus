import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  authMock,
  authState,
  swrMock,
  mockScopedSWR,
  mutate,
  resetListHarness,
  renderList,
} from "@/lib/list-test-harness";

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
};

beforeEach(() => {
  resetListHarness();
  asOwner(true);
});

describe("A2aEndpointsList", () => {
  it("lists each endpoint with its agent, and lets the Owner add one", () => {
    mockScopedSWR({ "/a2a-endpoints": [ENDPOINT] });
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

  it("offers no Add endpoint to an Org Admin in another Owner's workspace", () => {
    asOwner(false);
    mockScopedSWR({ "/a2a-endpoints": [ENDPOINT] });
    renderList(<A2aEndpointsList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText("Acme helpdesk")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Add endpoint/ }),
    ).not.toBeInTheDocument();
  });

  it("shows a skeleton while the endpoints load", () => {
    mockScopedSWR({ "/a2a-endpoints": { isLoading: true } });
    renderList(<A2aEndpointsList orgId="org1" workspaceId="ws1" />);

    expect(
      screen.getByRole("status", { name: "Loading A2A endpoints" }),
    ).toBeInTheDocument();
  });

  it("says when there are no endpoints, and offers to add one", () => {
    mockScopedSWR({ "/a2a-endpoints": [] });
    renderList(<A2aEndpointsList orgId="org1" workspaceId="ws1" />);

    expect(
      screen.getByText("No A2A endpoints in this workspace."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Add endpoint/ }),
    ).toBeInTheDocument();
  });

  it("shows a failed read as an error with a retry, not as no endpoints", () => {
    mockScopedSWR({
      "/a2a-endpoints": { error: { status: 500, message: "Server error" } },
    });
    renderList(<A2aEndpointsList orgId="org1" workspaceId="ws1" />);

    expect(
      screen.getByText("Failed to load A2A endpoints. Server error"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No A2A endpoints in this workspace."),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalled();
  });
});
