import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { OrgMemberListItem, Provider } from "@platypus/schemas";
import {
  authMock,
  mockScopedSWR,
  navigationMock,
  renderList,
  resetListHarness,
  stubAcceptedSave,
  swrMock,
  toastMock,
  toastSuccess,
} from "@/lib/list-test-harness";
import { selectOption } from "@/lib/test-utils";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("next/navigation", () => navigationMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { TransferWorkspaceAction } from "./transfer-workspace-dialog";

const memberOf = (id: string, name: string, isBanned = false) =>
  ({
    id: `m-${id}`,
    userId: id,
    role: "member",
    user: { id, name, email: `${id}@example.com` },
    isSuperAdmin: false,
    isBanned,
  }) as OrgMemberListItem;

const workspace = {
  id: "ws-1",
  name: "Support",
  ownerId: "u-old",
  organizationId: "org1",
};
const providers = [
  { id: "p-1", name: "Team OpenAI", workspaceId: "ws-1" },
  { id: "p-org", name: "Shared Anthropic", organizationId: "org1" },
] as Provider[];

const renderAction = () =>
  renderList(
    <TransferWorkspaceAction
      orgId="org1"
      workspaceId="ws-1"
      providers={providers}
    />,
  );

beforeEach(() => resetListHarness());

describe("TransferWorkspaceAction", () => {
  it("is disabled with an invite hint when nobody can receive the Workspace", () => {
    mockScopedSWR({
      "/workspaces/ws-1": { data: workspace },
      "/members": [memberOf("u-old", "Olive"), memberOf("u-b", "Bea", true)],
    });
    renderAction();

    expect(screen.getByRole("button", { name: "Transfer" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Invite someone" })).toBeTruthy();
  });

  it("confirms the consequences, then transfers to the chosen member", async () => {
    mockScopedSWR({
      "/workspaces/ws-1": { data: workspace },
      "/members": [memberOf("u-old", "Olive"), memberOf("u-new", "Nina")],
    });
    const fetchMock = stubAcceptedSave(workspace);
    renderAction();

    fireEvent.click(screen.getByRole("button", { name: "Transfer" }));
    await selectOption(
      screen.getByRole("combobox", { name: "New owner" }),
      "Nina (u-new@example.com)",
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText(/Olive loses access immediately/)).toBeTruthy();
    expect(screen.getByText(/Every Trigger is switched off/)).toBeTruthy();
    expect(
      screen.getByText(/Boards, Cards, Sandbox files and Dashboards are kept/),
    ).toBeTruthy();
    expect(screen.getByText("Team OpenAI")).toBeTruthy();
    expect(screen.queryByText("Shared Anthropic")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Transfer" }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Workspace transferred"),
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://test/organizations/org1/workspaces/ws-1/transfer");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      newOwnerId: "u-new",
      keepHistory: true,
    });
  });
});
