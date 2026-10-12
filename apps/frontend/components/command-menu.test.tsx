import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import {
  authMock,
  mockScopedSWR,
  mutate,
  navigationMock,
  renderList,
  resetListHarness,
  swrMock,
} from "@/lib/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("next/navigation", () => navigationMock);
vi.mock("swr", () => swrMock);

import { CommandMenu } from "./command-menu";

const openMenu = () => {
  renderList(<CommandMenu orgId="org1" workspaceId="ws1" />);
  act(() => {
    fireEvent.keyDown(document, { key: "k", metaKey: true });
  });
};

beforeEach(() => {
  resetListHarness();
  // cmdk scrolls the selected item into view, which jsdom doesn't implement.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("CommandMenu", () => {
  it("lists the workspace's agents", () => {
    mockScopedSWR({ "/agents": [{ id: "a1", name: "Researcher" }] });
    openMenu();

    expect(screen.getByText("Researcher")).toBeInTheDocument();
  });

  it("lists pinned agents first, in their own group", () => {
    mockScopedSWR({
      "/agents": [
        { id: "a1", name: "Researcher", isPinned: false },
        { id: "a2", name: "Writer", isPinned: true },
      ],
    });
    openMenu();

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

  it("shows no Pinned agents group when nothing is pinned", () => {
    mockScopedSWR({ "/agents": [{ id: "a1", name: "Researcher" }] });
    openMenu();

    expect(screen.queryByRole("group", { name: "Pinned agents" })).toBeNull();
  });

  it.each(["agents", "boards", "triggers"])(
    "offers to retry a failed %s read rather than dropping the group",
    (subject) => {
      mockScopedSWR({
        [`/${subject}`]: { error: { status: 500, message: "Server error" } },
      });
      openMenu();

      const retry = screen.getByRole("option", {
        name: `Couldn't load ${subject}. Retry`,
      });
      fireEvent.click(retry);

      expect(mutate).toHaveBeenCalled();
      // Retrying keeps the menu open, so the reloaded rows land in view.
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    },
  );
});
