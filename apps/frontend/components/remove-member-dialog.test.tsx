import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { OrgMemberListItem } from "@platypus/schemas";
import {
  authMock,
  mockScopedSWR,
  navigationMock,
  renderList,
  resetListHarness,
  stubAcceptedSave,
  swrMock,
  toastMock,
} from "@/lib/list-test-harness";
import { selectOption } from "@/lib/test-utils";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("next/navigation", () => navigationMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { RemoveMemberDialog } from "./remove-member-dialog";

const memberOf = (
  id: string,
  name: string,
  extra: Partial<OrgMemberListItem> = {},
): OrgMemberListItem =>
  ({
    id: `m-${id}`,
    organizationId: "org1",
    userId: id,
    role: "member",
    createdAt: new Date(),
    updatedAt: new Date(),
    user: { id, name, email: `${id}@example.com` },
    isSuperAdmin: false,
    isBanned: false,
    ...extra,
  }) as OrgMemberListItem;

const olive = memberOf("u-old", "Olive");
const nina = memberOf("u-new", "Nina");
const bea = memberOf("u-banned", "Bea", { isBanned: true });

const workspace = (id: string, name: string, ownerId = "u-old") => ({
  id,
  name,
  ownerId,
  organizationId: "org1",
});

const onSuccess = vi.fn();
const renderDialog = (members: OrgMemberListItem[]) =>
  renderList(
    <RemoveMemberDialog
      orgId="org1"
      member={olive}
      members={members}
      open
      onOpenChange={() => {}}
      onSuccess={onSuccess}
    />,
  );

const removeButton = () => screen.getByRole("button", { name: "Remove" });
const actionFor = (name: string) =>
  screen.getByRole("combobox", { name: `Action for ${name}` });
const sentBody = (fetchMock: ReturnType<typeof stubAcceptedSave>) => {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, method: init.method, body: JSON.parse(String(init.body)) };
};

beforeEach(() => {
  resetListHarness();
  onSuccess.mockReset();
});

describe("RemoveMemberDialog", () => {
  it("is a plain confirmation for a member who owns no Workspaces, and never claims to delete any", async () => {
    mockScopedSWR({ "/workspaces": [workspace("ws-x", "Nina's", "u-new")] });
    const fetchMock = stubAcceptedSave({ message: "ok" });
    renderDialog([olive, nina]);

    expect(screen.queryByText(/delete all/i)).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(removeButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(sentBody(fetchMock)).toEqual({
      url: "http://test/organizations/org1/members/m-u-old",
      method: "DELETE",
      body: { workspaces: [] },
    });
  });

  it("requires a choice for every Workspace the member owns before removing", async () => {
    mockScopedSWR({
      "/workspaces": [workspace("ws-a", "Alpha"), workspace("ws-b", "Beta")],
    });
    const fetchMock = stubAcceptedSave({ message: "ok" });
    renderDialog([olive, nina]);

    expect(removeButton()).toBeDisabled();
    await selectOption(actionFor("Alpha"), "Transfer");
    expect(removeButton()).toBeDisabled();
    await selectOption(
      screen.getByRole("combobox", { name: "New owner" }),
      "Nina (u-new@example.com)",
    );
    expect(removeButton()).toBeDisabled();
    await selectOption(actionFor("Beta"), "Delete");
    expect(removeButton()).toBeEnabled();

    fireEvent.click(removeButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(sentBody(fetchMock).body).toEqual({
      workspaces: [
        {
          workspaceId: "ws-a",
          action: "transfer",
          newOwnerId: "u-new",
          keepHistory: true,
        },
        { workspaceId: "ws-b", action: "delete" },
      ],
    });
  });

  it("copies the first Workspace's choices to the rest with apply to all", async () => {
    mockScopedSWR({
      "/workspaces": [workspace("ws-a", "Alpha"), workspace("ws-b", "Beta")],
    });
    const fetchMock = stubAcceptedSave({ message: "ok" });
    renderDialog([olive, nina]);

    await selectOption(actionFor("Alpha"), "Transfer");
    await selectOption(
      screen.getByRole("combobox", { name: "New owner" }),
      "Nina (u-new@example.com)",
    );
    fireEvent.click(screen.getByRole("switch", { name: "Keep history" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply to all" }));
    fireEvent.click(removeButton());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(sentBody(fetchMock).body.workspaces).toEqual(
      ["ws-a", "ws-b"].map((workspaceId) => ({
        workspaceId,
        action: "transfer",
        newOwnerId: "u-new",
        keepHistory: false,
      })),
    );
  });

  it("offers only Delete when nobody can receive a transfer", async () => {
    mockScopedSWR({ "/workspaces": [workspace("ws-a", "Alpha")] });
    renderDialog([olive, bea]);

    fireEvent.keyDown(actionFor("Alpha"), { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: "Delete" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Transfer" })).toBeNull();
    expect(screen.getByText(/Invite someone/)).toBeInTheDocument();
  });
});
