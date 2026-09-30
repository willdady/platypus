import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
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

  it("offers to retry a failed agents read rather than dropping the group", () => {
    mockScopedSWR({
      "/agents": { error: { status: 500, message: "Server error" } },
    });
    openMenu();

    const retry = screen.getByRole("option", {
      name: "Couldn't load agents. Retry",
    });
    fireEvent.click(retry);

    expect(mutate).toHaveBeenCalled();
    // Retrying keeps the menu open, so the reloaded agents land in view.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
