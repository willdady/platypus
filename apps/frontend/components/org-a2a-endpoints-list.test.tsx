import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  authMock,
  toastMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  stubAcceptedSave,
  mutate,
} from "@/lib/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { OrgA2aEndpointsList } from "./org-a2a-endpoints-list";

const endpoint = (over: Record<string, unknown> = {}) => ({
  id: "ep-1",
  name: "Support desk",
  enabled: true,
  agentId: "agent-1",
  agentName: "Helper",
  workspaceId: "ws-1",
  workspaceName: "Support",
  ownerId: "user-1",
  ownerName: "Dana Owner",
  createdAt: "2026-09-01T10:00:00.000Z",
  tokens: [
    {
      id: "tok-1",
      endpointId: "ep-1",
      name: "Telegram",
      createdAt: "2026-09-02T10:00:00.000Z",
    },
  ],
  ...over,
});

/** Opens the row's revoke dialog, then confirms it. */
const revoke = async (name: string, label: string) => {
  fireEvent.click(screen.getByRole("button", { name }));
  const buttons = await screen.findAllByRole("button", { name: label });
  fireEvent.click(buttons[buttons.length - 1]);
};

beforeEach(resetListHarness);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OrgA2aEndpointsList", () => {
  it("lists each endpoint with its Agent, Workspace and Owner, and its tokens beneath", () => {
    mockScopedSWR({ "/a2a/endpoints": [endpoint({ enabled: false })] });
    renderList(<OrgA2aEndpointsList orgId="org1" />);

    const [, endpointRow, tokenRow] = screen.getAllByRole("row");
    expect(within(endpointRow).getByText("Support desk")).toBeInTheDocument();
    expect(within(endpointRow).getByText("Agent: Helper")).toBeInTheDocument();
    expect(within(endpointRow).getByText("Support")).toBeInTheDocument();
    expect(within(endpointRow).getByText("Dana Owner")).toBeInTheDocument();
    expect(within(endpointRow).getByText("Disabled")).toBeInTheDocument();
    expect(within(tokenRow).getByText("Telegram")).toBeInTheDocument();
  });

  it("offers revoke and nothing that edits", () => {
    mockScopedSWR({ "/a2a/endpoints": [endpoint()] });
    renderList(<OrgA2aEndpointsList orgId="org1" />);

    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Revoke endpoint",
      "Revoke token",
    ]);
  });

  it("revokes an endpoint through the Org route and revalidates", async () => {
    const fetchMock = stubAcceptedSave({ message: "A2A endpoint revoked" });
    mockScopedSWR({ "/a2a/endpoints": [endpoint()] });
    renderList(<OrgA2aEndpointsList orgId="org1" />);

    await revoke("Revoke endpoint", "Revoke endpoint");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/a2a/endpoints/ep-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("revokes one token through the Org route and revalidates", async () => {
    const fetchMock = stubAcceptedSave({ message: "A2A token revoked" });
    mockScopedSWR({ "/a2a/endpoints": [endpoint()] });
    renderList(<OrgA2aEndpointsList orgId="org1" />);

    await revoke("Revoke token Telegram", "Revoke token");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/a2a/endpoints/ep-1/tokens/tok-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("says so when no Workspace has one", () => {
    mockScopedSWR({ "/a2a/endpoints": [] });
    renderList(<OrgA2aEndpointsList orgId="org1" />);

    expect(
      screen.getByText(/No workspace in this organization has an A2A endpoint/),
    ).toBeInTheDocument();
  });
});
