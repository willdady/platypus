import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { OrgMemberListItem } from "@platypus/schemas";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  menuItemLabels,
  renderList,
  resetListHarness,
  setupUser,
  stubAcceptedSave,
} from "@/test/list-test-harness";
import { selectOption } from "@/test/test-utils";
import type { Serialized } from "@/lib/api-write";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { MembersList } from "./members-list";

const memberOf = (
  id: string,
  name: string,
  extra: Partial<Serialized<OrgMemberListItem>> = {},
) =>
  ({
    id: `m-${id}`,
    role: "member",
    user: { id, name, email: `${id}@example.com` },
    isSuperAdmin: false,
    isBanned: false,
    ...extra,
  }) as unknown as Serialized<OrgMemberListItem>;

const nina = memberOf("u-nina", "Nina");
const sam = memberOf("u-sam", "Sam", { role: "admin", isSuperAdmin: true });

const onUpdate = vi.fn();
const renderMembers = (members: Serialized<OrgMemberListItem>[]) =>
  renderList(
    <MembersList orgId="org1" members={members} onUpdate={onUpdate} />,
  );
const openActionsFor = (name: string) =>
  setupUser().click(
    screen.getByRole("button", { name: `Actions for ${name}` }),
  );

beforeEach(() => {
  resetListHarness();
  onUpdate.mockReset();
  mockScopedSWR({ "/workspaces": [] }, { strict: true });
});

describe("MembersList", () => {
  // A Super Admin's org role is overridden, so the badge says so instead.
  it("shows each member with their role, Super Admin over the org role", async () => {
    await renderMembers([nina, sam]);

    expect(screen.getByText("u-nina@example.com")).toBeInTheDocument();
    expect(screen.getByText("member")).toBeInTheDocument();
    expect(screen.getByText("Super Admin")).toBeInTheDocument();
    expect(screen.queryByText("admin")).not.toBeInTheDocument();
  });

  // A Super Admin's membership isn't the org's to change.
  it("offers no actions for a Super Admin", async () => {
    await renderMembers([sam]);
    await openActionsFor("Sam");

    expect(menuItemLabels()).toEqual(["Super Admin - No actions available"]);
  });

  it("offers edit and remove for a regular member", async () => {
    await renderMembers([nina]);
    await openActionsFor("Nina");

    expect(menuItemLabels()).toEqual(["Edit org role", "Remove from Org"]);
  });

  // The list rereads once a role change lands, and the dialog goes away.
  it("opens the role editor and rereads the list after a save", async () => {
    stubAcceptedSave({ id: "m-u-nina", role: "admin" });
    await renderMembers([nina]);
    await openActionsFor("Nina");
    await setupUser().click(screen.getByText("Edit org role"));

    expect(await screen.findByText("Edit Member Role")).toBeInTheDocument();
    await selectOption(
      screen.getByRole("combobox", { name: "Organization Role" }),
      "Admin",
    );
    await setupUser().click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("opens the remove dialog for the chosen member", async () => {
    await renderMembers([nina]);
    await openActionsFor("Nina");
    await setupUser().click(screen.getByText("Remove from Org"));

    expect(await screen.findByRole("dialog")).toHaveTextContent("Nina");
  });
});
