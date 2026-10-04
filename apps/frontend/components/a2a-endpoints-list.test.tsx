import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import {
  authMock,
  authState,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
} from "@/lib/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { A2aEndpointsList } from "./a2a-endpoints-list";

const asOwner = (owns: boolean) =>
  Object.assign(authState, { ownsWorkspace: owns });

beforeEach(() => {
  resetListHarness();
  mockScopedSWR({
    "/a2a-endpoints": [
      {
        id: "ep-1",
        agentId: "agent-1",
        name: "Acme helpdesk",
        enabled: false,
      },
    ],
    "/agents": [{ id: "agent-1", name: "Helper" }],
  });
});

describe("A2aEndpointsList", () => {
  it("lists each endpoint with its agent, and lets the Owner add one", () => {
    asOwner(true);
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
    renderList(<A2aEndpointsList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText("Acme helpdesk")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Add endpoint/ }),
    ).not.toBeInTheDocument();
  });
});
