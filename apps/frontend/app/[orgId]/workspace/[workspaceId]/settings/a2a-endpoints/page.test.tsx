import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import {
  authMock,
  mockScopedSWR,
  renderList,
  resetListHarness,
  swrMock,
} from "@/lib/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import A2aEndpointsPage from "./page";

const renderPage = async () =>
  renderList(
    await A2aEndpointsPage({
      params: Promise.resolve({ orgId: "org1", workspaceId: "ws1" }),
    }),
  );

beforeEach(() => resetListHarness());

describe("A2aEndpointsPage", () => {
  it("warns that runs act as the Owner, with all of the agent's tools", async () => {
    mockScopedSWR({ "/a2a-endpoints": [] });
    await renderPage();

    expect(
      screen.getByText("Runs act as you, with all of the agent's tools"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/every run acts as you with every tool the agent has/),
    ).toBeInTheDocument();
  });

  it("keeps the warning above the endpoints", async () => {
    mockScopedSWR({
      "/a2a-endpoints": [
        {
          id: "ep-1",
          name: "Acme helpdesk",
          agentName: "Helper",
          enabled: true,
        },
      ],
    });
    await renderPage();

    const warning = screen.getByText(
      "Runs act as you, with all of the agent's tools",
    );
    const endpoint = screen.getByText("Acme helpdesk");
    expect(
      warning.compareDocumentPosition(endpoint) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
