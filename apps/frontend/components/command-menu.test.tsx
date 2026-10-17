import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import {
  authMock,
  mockScopedSWR,
  mutate,
  push,
  renderList,
  resetListHarness,
  swrMock,
  type ListRead,
} from "@/test/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { CommandMenu } from "./command-menu";

async function openMenu() {
  await renderList(<CommandMenu orgId="org1" workspaceId="ws1" />);
  act(() => {
    fireEvent.keyDown(document, { key: "k", metaKey: true });
  });
}

beforeEach(() => {
  resetListHarness();
});

describe("CommandMenu", () => {
  it("lists the workspace's agents", async () => {
    mockScopedSWR({ "/agents": [{ id: "a1", name: "Researcher" }] });
    await openMenu();

    expect(screen.getByText("Researcher")).toBeInTheDocument();
  });

  it("lists pinned agents first, in their own group", async () => {
    mockScopedSWR({
      "/agents": [
        { id: "a1", name: "Researcher", isPinned: false },
        { id: "a2", name: "Writer", isPinned: true },
      ],
    });
    await openMenu();

    const pinned = screen.getByRole("group", { name: "Pinned agents" });
    const rest = screen.getByRole("group", { name: "Agents" });
    expect(
      within(pinned)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Writer"]);
    expect(
      within(rest)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Researcher"]);
    expect(
      pinned.compareDocumentPosition(rest) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows no Pinned agents group when nothing is pinned", async () => {
    mockScopedSWR({ "/agents": [{ id: "a1", name: "Researcher" }] });
    await openMenu();

    expect(
      screen.queryByRole("group", { name: "Pinned agents" }),
    ).not.toBeInTheDocument();
  });

  it.each(["agents", "boards", "triggers"])(
    "offers to retry a failed %s read rather than dropping the group",
    async (subject) => {
      mockScopedSWR({
        [`/${subject}`]: { error: { status: 500, message: "Server error" } },
      });
      await openMenu();

      const retry = screen.getByRole("option", {
        name: `Couldn't load ${subject}. Retry`,
      });
      fireEvent.click(retry);

      expect(mutate).toHaveBeenCalled();
      // Retrying keeps the menu open, so the reloaded rows land in view.
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    },
  );

  it("disables New chat once the workspace is known to have no providers", async () => {
    mockScopedSWR({ "/providers": [] });
    await openMenu();

    const item = screen.getByRole("option", { name: "New chat" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    expect(push).not.toHaveBeenCalled();
  });

  it.each<[string, ListRead]>([
    ["loading", { isLoading: true }],
    ["errored", { error: { status: 500, message: "Server error" } }],
    ["has providers", [{ id: "p1" }]],
  ])("opens a new chat while the providers read is %s", async (_, read) => {
    mockScopedSWR({ "/providers": read });
    await openMenu();

    fireEvent.click(screen.getByRole("option", { name: "New chat" }));
    expect(push).toHaveBeenCalledWith("/org1/workspace/ws1/chat");
  });
});
